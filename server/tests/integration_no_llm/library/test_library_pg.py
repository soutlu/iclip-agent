"""资料库的 Postgres 查询：按 ADR-0002 一段对话一张卡，核卡的归属、卡面、镜头组、血缘、筛选与翻页。

主体数据用原生 SQL 直插，时间戳自己定（业务仓储都用数据库时钟，控不住时刻）；与生成仓储对照的
那条用例用分叉场景构造器，走数据库时钟。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from iclip.common.shot_prompt import ShotCut, ShotScript, format_shot_prompt
from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import STATUS_COMPLETED, STATUS_FAILED
from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    OPERATION_COMPOSE,
    OPERATION_GENERATE,
    OPERATION_UPLOAD,
)
from iclip.domains.library.models import Scope, VideoCursor
from iclip.domains.library.reports_pg import PgLibraryReports
from iclip.domains.library.schemas import ShotGroupOut
from tests.helpers.fork_lineage import three_level_fork
from tests.helpers.pg import reset_database

BASE = datetime(2026, 9, 20, 10, 0, tzinfo=UTC)
NINA = "Nina.He"
LEO = "Leo.Sun"
SHAN = "Shan.Hu"
"""只出现在请求的 ``user_name`` 里、没有账号的名字：资料库的作者一律按属主，不认它。"""

SHOT_ONE: dict[str, Any] = {
    "global_settings": "浅灰地面与白墙，干净留白。",
    "timeline": [
        {"timestamps": [0, 3], "prompt": "空地面停一拍。", "image_indexes": []},
        {"timestamps": [3, 7], "prompt": "踩入 @Image1 夹趾凉鞋。", "image_indexes": [1]},
    ],
}
SHOT_ONE_PROMPT = format_shot_prompt(
    ShotScript(
        global_settings=SHOT_ONE["global_settings"],
        timeline=tuple(
            ShotCut(
                timestamps=(cut["timestamps"][0], cut["timestamps"][1]),
                prompt=cut["prompt"],
                image_indexes=tuple(cut["image_indexes"]),
            )
            for cut in SHOT_ONE["timeline"]
        ),
    )
)
"""受理时服务端照 shot 拼出、与 shot 一起存进请求的正文。"""
SHOT_ONE_CUTS = ["空地面停一拍。", "踩入 @Image1 夹趾凉鞋。"]
MARKER_PROMPT = (
    "浅灰地面与白墙。\n\n[0–4秒｜镜头1] 换成编织凉鞋 @Image1。\n[4–8秒｜镜头2] 向前迈一步。\n"
    "不要生成字幕，不要生成背景音乐。"
)


def at(minutes: float) -> datetime:
    return BASE + timedelta(minutes=minutes)


def url(name: str) -> str:
    return f"https://oss.example.test/{name}.mp4"


def shape(groups: Sequence[ShotGroupOut]) -> list[tuple[int | None, list[uuid.UUID]]]:
    return [(group.shot_index, [version.job_id for version in group.versions]) for group in groups]


class Seed:
    """两个人、四段对话、三条不挂对话的出片。时刻是距 BASE 的分钟数，写作「建立 → 完成」。

    c1 Nina「春夏凉鞋合集」（-60 建）：镜 1 A（结构化 shot，0 → 5）、B（拼好的正文，60 → 65）、
    A 上的合成 M（90 → 92）；镜 2 C 失败、D（30 → 50）、D2（40 → 45，晚建早完成）；没镜号的
    P（10 → 12）与它上面的合成 PC（79 → 80）、Q（11 → 13）。
    c2 Leo「滑板街拍」（-60 建）：E（40 → 130）与它上面的编辑段（131 → 132）。
    c4 Leo 分叉自 c1（50 建，D 的完成时刻正好等于边界）：在继承来的 A 上剪出合成 Y（100 → 101），
    自己出 G（110 → 120）。c5 Leo 分叉自 c1（70 建），没有自己的行。
    不挂对话：Nina 的横版纯文本 H（10 → 14）与它上面的合成 HC（40 → 42），Leo 的 K（15 → 16）。
    H、HC、Y 的请求里写的是 SHAN。
    """

    def __init__(self) -> None:
        self.nina, self.leo = uuid.uuid4(), uuid.uuid4()
        self.c1, self.c2, self.c4, self.c5 = (uuid.uuid4() for _ in range(4))
        self.a, self.b, self.m, self.c, self.d, self.d2 = (uuid.uuid4() for _ in range(6))
        self.p, self.pc, self.q, self.e, self.e_edit = (uuid.uuid4() for _ in range(5))
        self.y, self.g, self.h, self.hc, self.k = (uuid.uuid4() for _ in range(5))

    async def plant(self, engine: AsyncEngine) -> None:
        async with engine.begin() as conn:
            for user_id, name in ((self.nina, NINA), (self.leo, LEO)):
                await conn.execute(
                    text(
                        "INSERT INTO iclip.users (id, username, email, hashed_password, is_active,"
                        " is_superuser, is_verified, display_name, avatar_url, roles,"
                        " direct_permissions, city, job_title, departments)"
                        " VALUES (:id, :name, :email, 'x', true, false, true, :name, '',"
                        " '[\"editor\"]'::jsonb, '[]'::jsonb, '', '', '[]'::jsonb)"
                    ),
                    {"id": user_id, "name": name, "email": f"{name}@example.test"},
                )
            await _conversation(conn, self.c1, owner=self.nina, title="春夏凉鞋合集", created=-60)
            await _conversation(conn, self.c2, owner=self.leo, title="滑板街拍", created=-60)
            await _conversation(
                conn,
                self.c4,
                owner=self.leo,
                title="凉鞋合集（分叉）",
                created=50,
                forked_from=self.c1,
            )
            await _conversation(
                conn, self.c5, owner=self.leo, title="空分叉", created=70, forked_from=self.c1
            )

            nina_c1: dict[str, Any] = {"owner": self.nina, "user_name": NINA}
            await _video(
                conn,
                self.a,
                self.c1,
                **nina_c1,
                shot=1,
                created=0,
                finished=5,
                url_name="a",
                request={"shot": SHOT_ONE, "prompt": SHOT_ONE_PROMPT},
            )
            await _video(
                conn,
                self.b,
                self.c1,
                **nina_c1,
                shot=1,
                created=60,
                finished=65,
                url_name="b",
                request={"prompt": MARKER_PROMPT},
            )
            await _composite(
                conn,
                self.m,
                self.c1,
                **nina_c1,
                base=self.a,
                created=90,
                finished=92,
                url_name="m",
                duration_ms=7040,
            )
            await _video(
                conn,
                self.c,
                self.c1,
                **nina_c1,
                shot=2,
                created=20,
                finished=None,
                url_name="c",
                status=STATUS_FAILED,
            )
            await _video(conn, self.d, self.c1, **nina_c1, shot=2, created=30, finished=50)
            await _video(conn, self.d2, self.c1, **nina_c1, shot=2, created=40, finished=45)
            await _video(conn, self.p, self.c1, **nina_c1, shot=None, created=10, finished=12)
            await _composite(
                conn, self.pc, self.c1, **nina_c1, base=self.p, created=79, finished=80
            )
            await _video(conn, self.q, self.c1, **nina_c1, shot=None, created=11, finished=13)

            await _video(
                conn,
                self.e,
                self.c2,
                owner=self.leo,
                user_name=LEO,
                shot=1,
                created=40,
                finished=130,
                request={"prompt": "滑板 100% 落地。"},
            )
            await _edit(
                conn, self.e_edit, self.c2, owner=self.leo, base=self.e, created=131, finished=132
            )

            await _composite(
                conn,
                self.y,
                self.c4,
                owner=self.leo,
                user_name=SHAN,
                base=self.a,
                created=100,
                finished=101,
                url_name="y",
                duration_ms=6500,
            )
            await _video(
                conn,
                self.g,
                self.c4,
                owner=self.leo,
                user_name=LEO,
                shot=1,
                created=110,
                finished=120,
            )

            await _video(
                conn,
                self.h,
                None,
                owner=self.nina,
                user_name=SHAN,
                shot=None,
                created=10,
                finished=14,
                request={"prompt": "一条横版的纯文本描述。", "aspect_ratio": "16:9"},
            )
            await _composite(
                conn,
                self.hc,
                None,
                owner=self.nina,
                user_name=SHAN,
                base=self.h,
                created=40,
                finished=42,
            )
            await _video(
                conn,
                self.k,
                None,
                owner=self.leo,
                user_name=LEO,
                shot=None,
                created=15,
                finished=16,
            )


async def _conversation(
    conn: AsyncConnection,
    conversation_id: uuid.UUID,
    *,
    owner: uuid.UUID,
    title: str,
    created: float,
    forked_from: uuid.UUID | None = None,
) -> None:
    await conn.execute(
        text(
            "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, created_at,"
            " updated_at, forked_from, fork_turn)"
            " VALUES (:id, :owner, 'storyboard', :title, :at, :at, :forked_from, :fork_turn)"
        ),
        {
            "id": conversation_id,
            "owner": owner,
            "title": title,
            "at": at(created),
            "forked_from": forked_from,
            "fork_turn": 1 if forked_from else None,
        },
    )


async def _video(
    conn: AsyncConnection,
    video_id: uuid.UUID,
    conversation_id: uuid.UUID | None,
    *,
    owner: uuid.UUID,
    user_name: str,
    shot: int | None,
    created: float,
    finished: float | None,
    url_name: str | None = None,
    status: str = STATUS_COMPLETED,
    request: dict[str, Any] | None = None,
) -> None:
    """一条出片；地址按 ``url_name`` 起，缺省用 id。"""

    name = url_name or str(video_id)
    body: dict[str, Any] = {
        "model": "mmt-seedance-2-5",
        "prompt": "占位正文。",
        "user_name": user_name,
        "aspect_ratio": "9:16",
        "seconds": 10,
        "reference_image_urls": ["https://oss.example.test/frame-1.jpg"],
        **(request or {}),
    }
    await conn.execute(
        text(
            "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
            " operation, provider, request, status, shot_index, output_url,"
            " watermark_output_url, created_at, finished_at)"
            " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'test',"
            " CAST(:request AS jsonb), :status, :shot, :output_url, :watermark_url, :created_at,"
            " :finished_at)"
        ),
        {
            "id": video_id,
            "owner": owner,
            "conversation_id": conversation_id,
            "kind": KIND_VIDEO,
            "operation": OPERATION_GENERATE,
            "request": json.dumps(body),
            "status": status,
            "shot": shot,
            "output_url": url(name) if status == STATUS_COMPLETED else None,
            "watermark_url": url(f"{name}-wm") if status == STATUS_COMPLETED else None,
            "created_at": at(created),
            "finished_at": None if finished is None else at(finished),
        },
    )


async def _edit(
    conn: AsyncConnection,
    edit_id: uuid.UUID,
    conversation_id: uuid.UUID | None,
    *,
    owner: uuid.UUID,
    base: uuid.UUID,
    created: float,
    finished: float,
) -> None:
    """在 ``base`` 那条成片上改一段：来源是它，原作与镜号随它。"""

    await conn.execute(
        text(
            "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
            " operation, provider, request, status, shot_index, source_job_id, root_job_id,"
            " range_start_ms, range_end_ms, output_url, created_at, finished_at)"
            " SELECT :id, :owner, CAST(:conversation_id AS uuid), :kind, :operation, 'test',"
            " CAST(:request AS jsonb), :status, shot_index, id, COALESCE(root_job_id, id),"
            " 1000, 4000, :output_url, :created_at, :finished_at"
            " FROM iclip.generation_jobs WHERE id = :base"
        ),
        {
            "id": edit_id,
            "owner": owner,
            "conversation_id": conversation_id,
            "kind": KIND_VIDEO,
            "operation": OPERATION_GENERATE,
            "request": json.dumps({"model": "mmt-seedance-2-5", "prompt": "改一段。"}),
            "status": STATUS_COMPLETED,
            "base": base,
            "output_url": url(f"{edit_id}-edit"),
            "created_at": at(created),
            "finished_at": at(finished),
        },
    )


async def _composite(
    conn: AsyncConnection,
    composite_id: uuid.UUID,
    conversation_id: uuid.UUID | None,
    *,
    owner: uuid.UUID,
    user_name: str,
    base: uuid.UUID,
    created: float,
    finished: float,
    url_name: str | None = None,
    duration_ms: int | None = None,
) -> None:
    """在 ``base`` 那条成片上剪一段再合成：先落编辑段（合成前两分钟建、前一分钟完成），合成以它为
    来源，原作与镜号随基底。合成请求按别名落库，归属标签的键是 ``userName``。"""

    edit_id = uuid.uuid4()
    await _edit(
        conn,
        edit_id,
        conversation_id,
        owner=owner,
        base=base,
        created=created - 2,
        finished=created - 1,
    )
    await conn.execute(
        text(
            "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
            " operation, provider, request, status, shot_index, source_job_id, root_job_id,"
            " output_url, duration_ms, created_at, finished_at)"
            " SELECT :id, :owner, CAST(:conversation_id AS uuid), :kind, :operation, 'local',"
            " CAST(:request AS jsonb), :status, shot_index, :edit, COALESCE(root_job_id, id),"
            " :output_url, :duration_ms, :created_at, :finished_at"
            " FROM iclip.generation_jobs WHERE id = :base"
        ),
        {
            "id": composite_id,
            "owner": owner,
            "conversation_id": conversation_id,
            "kind": KIND_VIDEO,
            "operation": OPERATION_COMPOSE,
            "request": json.dumps(
                {
                    "segments": [{"url": url(f"{edit_id}-edit"), "start": 0, "end": 3}],
                    "userName": user_name,
                }
            ),
            "status": STATUS_COMPLETED,
            "edit": edit_id,
            "base": base,
            "output_url": url(url_name or str(composite_id)),
            "duration_ms": duration_ms,
            "created_at": at(created),
            "finished_at": at(finished),
        },
    )


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    created = create_async_engine(migrated_pg)
    async with created.begin() as conn:
        await reset_database(conn)
    try:
        yield created
    finally:
        await created.dispose()


@pytest.fixture
async def seed(engine: AsyncEngine) -> Seed:
    planted = Seed()
    await planted.plant(engine)
    return planted


@pytest.fixture
def reports(engine: AsyncEngine) -> PgLibraryReports:
    return PgLibraryReports(engine)


async def ids(reports: PgLibraryReports, scope: Scope) -> list[uuid.UUID]:
    return [row.video.id for row in await reports.videos(scope, limit=20, after=None)]


async def test_library_sees_what_the_generation_repository_sees(
    engine: AsyncEngine, reports: PgLibraryReports
) -> None:
    """资料库手写的继承规则与生成仓储的是同一条：三层链逐跳边界、分叉时在途之后才完成的只进父、
    编辑段读得到却不是一版。"""

    chain = await three_level_fork(engine)
    repo = SqlGenerationRepository(engine)
    inheritance = await SqlConversationRepository(engine).ancestry(chain.child.id)
    listed = await repo.list_for_owner(
        owner=None, limit=50, conversation_id=chain.child.id, inherited=inheritance
    )
    masters = {
        job.id for job in listed if job.operation == OPERATION_COMPOSE or job.source_job_id is None
    }

    child = {v.job_id for g in await reports.groups_of(chain.child.id) for v in g.versions}
    parent = {v.job_id for g in await reports.groups_of(chain.parent.id) for v in g.versions}

    assert child == masters == {chain.own.id, chain.from_parent.id, chain.from_grand.id}
    assert parent == {
        chain.from_parent.id,
        chain.in_flight.id,
        chain.parent_after_child.id,
        chain.from_grand.id,
    }
    card = await reports.card_of(chain.child.id)
    assert card is not None and card.video.version_count == 3
    assert card.video.face.job_id == chain.own.id
    assert await reports.card_of(chain.parent.id) is not None
    assert await reports.card_of(chain.grand.id) is not None


async def test_one_card_per_conversation_ordered_by_the_face_finish_time(
    reports: PgLibraryReports, seed: Seed
) -> None:
    """E 建得早、完成得晚，排最前；它上面更晚完成的编辑段不当卡面。"""

    rows = await reports.videos(Scope(), limit=20, after=None)

    cards = [
        (
            row.video.id,
            row.video.face.job_id,
            row.video.face.kind,
            row.video.group_count,
            row.video.version_count,
        )
        for row in rows
    ]
    assert cards == [
        (seed.c2, seed.e, "take", 1, 1),
        (seed.c4, seed.g, "take", 4, 7),
        (seed.c1, seed.m, "composite", 4, 8),
        (seed.h, seed.hc, "composite", 1, 2),
        (seed.k, seed.k, "take", 1, 1),
    ]
    faces_at = [at(130), at(120), at(92), at(42), at(16)]
    assert [row.video.face.finished_at for row in rows] == faces_at
    assert await reports.count(Scope()) == 5


async def test_a_fork_card_holds_what_it_inherits_plus_its_own(
    reports: PgLibraryReports, seed: Seed
) -> None:
    """c4 读得到 c1 在它建立前完成的（D 正好等于边界也算），加上自己的 Y 与 G；B、M、PC 完成得晚，
    不进来。没镜号的 P、Q 各自一组。"""

    groups = await reports.groups_of(seed.c4)

    assert shape(groups) == [
        (1, [seed.a, seed.y, seed.g]),
        (2, [seed.d2, seed.d]),
        (None, [seed.p]),
        (None, [seed.q]),
    ]
    composite = groups[0].versions[1]
    assert composite.kind == "composite" and composite.take.id == seed.a
    assert composite.take.script is not None
    assert [cut.prompt for cut in composite.take.script.timeline] == SHOT_ONE_CUTS
    assert composite.user_name == LEO, "每一版的作者是它的属主，不看请求里的名字"
    assert composite.duration_ms == 6500 and composite.watermark_output_url is None
    inherited = groups[0].versions[0]
    assert inherited.kind == "take" and inherited.user_name == NINA
    assert inherited.watermark_output_url == url("a-wm") and inherited.duration_ms is None

    row = await reports.card_of(seed.c4)
    assert row is not None
    video = row.video
    assert (video.id, video.conversation_id, video.title) == (seed.c4, seed.c4, "凉鞋合集（分叉）")
    assert (video.group_count, video.version_count) == (4, 7)
    assert video.face.job_id == seed.g and video.user_name == LEO
    assert row.conversation_owner == seed.leo and not row.conversation_deleted


async def test_the_source_card_is_not_touched_by_its_forks(
    reports: PgLibraryReports, seed: Seed
) -> None:
    """c1 的卡只装 c1 读得到的：c4 在继承来的 A 上剪的 Y 不进来。卡面 M 是合成，脚本沿原作 A。"""

    groups = await reports.groups_of(seed.c1)

    assert shape(groups) == [
        (1, [seed.a, seed.b, seed.m]),
        (2, [seed.d2, seed.d]),
        (None, [seed.p, seed.pc]),
        (None, [seed.q]),
    ]
    parsed = groups[0].versions[1].take.script
    assert parsed is not None and parsed.global_settings == "浅灰地面与白墙。"
    assert [(cut.start, cut.end, cut.image_indexes) for cut in parsed.timeline] == [
        (0, 4, [1]),
        (4, 8, []),
    ]
    assert groups[0].versions[1].take.prompt == MARKER_PROMPT

    row = await reports.card_of(seed.c1)
    assert row is not None
    video = row.video
    assert video.face.kind == "composite" and video.face.job_id == seed.m
    assert video.face.output_url == url("m") and video.face.watermark_output_url is None
    assert video.face.duration_ms == 7040 and video.face.finished_at == at(92)
    assert video.take.id == seed.a and video.take.script is not None
    assert [cut.prompt for cut in video.take.script.timeline] == SHOT_ONE_CUTS
    assert (video.group_count, video.version_count) == (4, 8)
    assert video.user_name == NINA and video.agent_id == "storyboard"


async def test_a_fork_with_nothing_of_its_own_has_no_card(
    reports: PgLibraryReports, seed: Seed
) -> None:
    assert await reports.card_of(seed.c5) is None
    assert await reports.groups_of(seed.c5) == []
    assert seed.c5 not in await ids(reports, Scope())


async def test_a_take_without_a_conversation_is_a_card_with_its_composites(
    reports: PgLibraryReports, seed: Seed
) -> None:
    row = await reports.card_of(seed.h)

    assert row is not None
    video = row.video
    assert (video.id, video.conversation_id, video.title) == (seed.h, None, None)
    assert row.conversation_owner is None and not row.conversation_deleted
    assert video.face.job_id == seed.hc and video.take.id == seed.h
    assert video.take.script is None and video.take.aspect_ratio == "16:9"
    assert video.user_name == NINA
    groups = await reports.groups_of(seed.h)
    assert shape(groups) == [(None, [seed.h, seed.hc])]
    assert [version.user_name for version in groups[0].versions] == [NINA, NINA]
    assert shape(await reports.groups_of(seed.k)) == [(None, [seed.k])]


async def test_ids_that_are_not_cards_find_nothing(reports: PgLibraryReports, seed: Seed) -> None:
    for outside in (seed.a, seed.c, seed.m, seed.e_edit, uuid.uuid4()):
        assert await reports.card_of(outside) is None
        assert await reports.groups_of(outside) == []


async def test_filters_look_only_at_the_card_itself(reports: PgLibraryReports, seed: Seed) -> None:
    assert await ids(reports, Scope(user_name=LEO)) == [seed.c2, seed.c4, seed.k]
    assert await ids(reports, Scope(user_name=NINA)) == [seed.c1, seed.h]
    assert await ids(reports, Scope(user_name=SHAN)) == [], "作者是属主，不是请求里的名字"
    assert await ids(reports, Scope(orientation="landscape")) == [seed.h]
    assert seed.h not in await ids(reports, Scope(orientation="portrait"))
    assert await ids(reports, Scope(since=at(91), until=at(93))) == [seed.c1]
    assert await ids(reports, Scope(q="凉鞋合集")) == [seed.c4, seed.c1]
    # 卡面 M 对应的出片 A 的正文；c4 卡面 G 的正文里没有
    assert await ids(reports, Scope(q="夹趾")) == [seed.c1]
    assert await ids(reports, Scope(q="100%")) == [seed.c2]
    assert await ids(reports, Scope(q="100_")) == []
    assert await reports.count(Scope(user_name=NINA)) == 2


async def test_authors_count_cards_per_author(reports: PgLibraryReports, seed: Seed) -> None:
    authors = [(author.user_name, author.count) for author in await reports.authors()]

    assert authors == [(LEO, 3), (NINA, 2)]


async def test_keyset_pages_follow_the_face_finish_time(
    reports: PgLibraryReports, seed: Seed
) -> None:
    first = await reports.videos(Scope(), limit=2, after=None)
    last = first[-1].video
    second = await reports.videos(
        Scope(), limit=10, after=VideoCursor(at=last.face.finished_at, video_id=last.id)
    )

    assert [row.video.id for row in first] == [seed.c2, seed.c4]
    assert [row.video.id for row in second] == [seed.c1, seed.h, seed.k]


async def test_deleting_a_conversation_keeps_every_card(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    before = shape(await reports.groups_of(seed.c4))
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.conversations SET deleted_at = :at WHERE id = :id"),
            {"at": at(500), "id": seed.c1},
        )

    assert await ids(reports, Scope()) == [seed.c2, seed.c4, seed.c1, seed.h, seed.k]
    assert shape(await reports.groups_of(seed.c4)) == before
    source = await reports.card_of(seed.c1)
    fork = await reports.card_of(seed.c4)
    assert source is not None and source.conversation_deleted
    assert source.video.title == "春夏凉鞋合集"
    assert fork is not None and not fork.conversation_deleted


async def test_a_dangling_conversation_id_counts_as_no_conversation(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    """生成记录的对话 id 没有外键，指向不存在的对话时按不挂对话算：卡 id 是出片 id。"""

    stray = uuid.uuid4()
    async with engine.begin() as conn:
        await _video(
            conn,
            stray,
            uuid.uuid4(),
            owner=seed.leo,
            user_name=LEO,
            shot=1,
            created=190,
            finished=200,
        )

    row = await reports.card_of(stray)
    assert row is not None
    assert (row.video.id, row.video.conversation_id, row.video.title) == (stray, None, None)
    assert (await ids(reports, Scope()))[0] == stray


async def test_a_video_upload_is_not_a_card_or_a_version(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    """上传的视频不是通过本系统生成的：不挂对话也不自成一张卡，不进任何卡的版本。"""

    before = await ids(reports, Scope())
    before_c1 = shape(await reports.groups_of(seed.c1))
    upload = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, operation, provider,"
                " status, output_url, created_at, finished_at)"
                " VALUES (:id, :owner, :kind, :operation, 'upload', :status, :url, :at, :at)"
            ),
            {
                "id": upload,
                "owner": seed.nina,
                "kind": KIND_VIDEO,
                "operation": OPERATION_UPLOAD,
                "status": STATUS_COMPLETED,
                "url": url("uploaded"),
                "at": at(300),
            },
        )

    assert await ids(reports, Scope()) == before
    assert await reports.card_of(upload) is None
    assert shape(await reports.groups_of(seed.c1)) == before_c1
