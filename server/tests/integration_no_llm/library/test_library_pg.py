"""资料库的 Postgres 查询：按合同 §13 的收录口径，用一套手工种下的数据核卡片、卡面、脚本与筛选。

数据用原生 SQL 直插，时间戳自己定（业务仓储都用数据库时钟，控不住时刻）。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from iclip.common.shot_prompt import ShotCut, ShotScript, format_shot_prompt
from iclip.domains.generation.models import STATUS_COMPLETED, STATUS_FAILED
from iclip.domains.generation.schemas import KIND_VIDEO, OPERATION_COMPOSE, OPERATION_GENERATE
from iclip.domains.library.models import Scope, VideoCursor
from iclip.domains.library.reports_pg import PgLibraryReports
from tests.helpers.pg import reset_database

BASE = datetime(2026, 9, 20, 10, 0, tzinfo=UTC)
NINA = "Nina.He"
LEO = "Leo.Sun"
SHAN = "Shan.Hu"

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
MARKER_PROMPT = (
    "浅灰地面与白墙。\n\n[0–4秒｜镜头1] 换成编织凉鞋 @Image1。\n[4–8秒｜镜头2] 向前迈一步。\n"
    "不要生成字幕，不要生成背景音乐。"
)


def at(minutes: float) -> datetime:
    return BASE + timedelta(minutes=minutes)


def url(name: str) -> str:
    return f"https://oss.example.test/{name}.mp4"


class Seed:
    """两个人、四段对话（一段已删、一段是分叉）与一条不挂对话的钥匙出片。

    c1 镜 1：A（结构化 shot）、B（只有拼好的正文），A 名下有成片 M，M 比 B 晚，卡面是 M；
    c1 镜 2：C 失败、D 成了；c2：E 成了，另有它上面的一段编辑；c3 已删：F；
    c4 分叉自 c1：在 c4 里剪继承来的 A 得到成片 N（比 M 晚），加分叉后新出的 G；
    H：钥匙直提的纯文本横版。
    """

    def __init__(self) -> None:
        self.nina, self.leo = uuid.uuid4(), uuid.uuid4()
        self.c1, self.c2, self.c3, self.c4 = (uuid.uuid4() for _ in range(4))
        self.a, self.b, self.c, self.d, self.e = (uuid.uuid4() for _ in range(5))
        self.f, self.g, self.h, self.m, self.n = (uuid.uuid4() for _ in range(5))

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
            await self._conversation(conn, self.c1, owner=self.nina, title="春夏凉鞋合集")
            await self._conversation(conn, self.c2, owner=self.leo, title="滑板街拍")
            await self._conversation(
                conn, self.c3, owner=self.nina, title="删掉的试验", deleted_at=at(500)
            )
            await self._conversation(
                conn, self.c4, owner=self.leo, title="凉鞋合集（分叉）", forked_from=self.c1
            )

            await self._video(
                conn,
                self.a,
                self.c1,
                owner=self.nina,
                user_name=NINA,
                shot=1,
                created_at=at(0),
                url_name="a",
                request={"shot": SHOT_ONE, "prompt": SHOT_ONE_PROMPT},
            )
            await self._video(
                conn,
                self.b,
                self.c1,
                owner=self.nina,
                user_name=NINA,
                shot=1,
                created_at=at(60),
                url_name="b",
                request={"prompt": MARKER_PROMPT},
            )
            await self._composite(
                conn,
                self.m,
                self.c1,
                base=self.a,
                created_at=at(90),
                url_name="m",
                duration_ms=7040,
            )
            await self._video(
                conn,
                self.c,
                self.c1,
                owner=self.nina,
                user_name=NINA,
                shot=2,
                created_at=at(20),
                url_name="c",
                status=STATUS_FAILED,
            )
            await self._video(
                conn,
                self.d,
                self.c1,
                owner=self.nina,
                user_name=NINA,
                shot=2,
                created_at=at(30),
                url_name="d",
                request={"prompt": "纯描述。"},
            )

            await self._video(
                conn,
                self.e,
                self.c2,
                owner=self.leo,
                user_name=LEO,
                shot=1,
                created_at=at(40),
                url_name="e",
                request={"prompt": "滑板 100% 落地。"},
            )
            await self._video(
                conn,
                uuid.uuid4(),
                self.c2,
                owner=self.leo,
                user_name=LEO,
                shot=1,
                created_at=at(42),
                url_name="e-edit",
                edit_of=self.e,
            )

            await self._video(
                conn,
                self.f,
                self.c3,
                owner=self.nina,
                user_name=NINA,
                shot=1,
                created_at=at(45),
                url_name="f",
            )

            await self._composite(
                conn,
                self.n,
                self.c4,
                base=self.a,
                created_at=at(100),
                url_name="n",
                duration_ms=6500,
            )
            await self._video(
                conn,
                self.g,
                self.c4,
                owner=self.leo,
                user_name=LEO,
                shot=1,
                created_at=at(120),
                url_name="g",
            )

            await self._video(
                conn,
                self.h,
                None,
                owner=self.nina,
                user_name=SHAN,
                shot=None,
                created_at=at(10),
                url_name="h",
                request={"prompt": "一条横版的纯文本描述。", "aspect_ratio": "16:9"},
            )

    async def _conversation(
        self,
        conn: AsyncConnection,
        conversation_id: uuid.UUID,
        *,
        owner: uuid.UUID,
        title: str,
        deleted_at: datetime | None = None,
        forked_from: uuid.UUID | None = None,
    ) -> None:
        await conn.execute(
            text(
                "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, created_at,"
                " updated_at, deleted_at, forked_from, fork_turn)"
                " VALUES (:id, :owner, 'storyboard', :title, :at, :at, :deleted_at, :forked_from,"
                " :fork_turn)"
            ),
            {
                "id": conversation_id,
                "owner": owner,
                "title": title,
                "at": at(-60),
                "deleted_at": deleted_at,
                "forked_from": forked_from,
                "fork_turn": 1 if forked_from else None,
            },
        )

    async def _video(
        self,
        conn: AsyncConnection,
        video_id: uuid.UUID,
        conversation_id: uuid.UUID | None,
        *,
        owner: uuid.UUID,
        user_name: str,
        shot: int | None,
        created_at: datetime,
        url_name: str,
        status: str = STATUS_COMPLETED,
        request: dict[str, Any] | None = None,
        edit_of: uuid.UUID | None = None,
    ) -> None:
        """一条出片；给了 ``edit_of`` 就是那次出片上的一段编辑（来源与原作都是它）。"""

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
                " operation, provider, request, status, shot_index, source_job_id, root_job_id,"
                " range_start_ms, range_end_ms, output_url, watermark_output_url, created_at,"
                " updated_at, finished_at)"
                " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'test',"
                " CAST(:request AS jsonb), :status, :shot, :edit_of, :edit_of,"
                " :range_start_ms, :range_end_ms, :output_url, :watermark_url, :created_at,"
                " :created_at, :created_at)"
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
                "edit_of": edit_of,
                "range_start_ms": None if edit_of is None else 1000,
                "range_end_ms": None if edit_of is None else 4000,
                "output_url": url(url_name) if status == STATUS_COMPLETED else None,
                "watermark_url": url(f"{url_name}-wm") if status == STATUS_COMPLETED else None,
                "created_at": created_at,
            },
        )

    async def _composite(
        self,
        conn: AsyncConnection,
        composite_id: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        base: uuid.UUID,
        created_at: datetime,
        url_name: str,
        duration_ms: int | None = None,
    ) -> None:
        """在 ``base`` 那次出片上剪一段再合成：先落编辑段，合成以它为来源、原作是基底；
        两条的属主与镜号都照基底的。"""

        edit_id = uuid.uuid4()
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                " operation, provider, request, status, shot_index, source_job_id, root_job_id,"
                " range_start_ms, range_end_ms, output_url, created_at, updated_at, finished_at)"
                " SELECT :id, owner_user_id, :conversation_id, :kind, :operation, 'test',"
                " CAST(:request AS jsonb), :status, shot_index, :base, :base, 1000, 4000,"
                " :output_url, :created_at, :created_at, :created_at"
                " FROM iclip.generation_jobs WHERE id = :base"
            ),
            {
                "id": edit_id,
                "conversation_id": conversation_id,
                "kind": KIND_VIDEO,
                "operation": OPERATION_GENERATE,
                "request": json.dumps({"model": "mmt-seedance-2-5", "prompt": "改一段。"}),
                "status": STATUS_COMPLETED,
                "base": base,
                "output_url": url(f"{url_name}-edit"),
                "created_at": created_at - timedelta(minutes=1),
            },
        )
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                " operation, provider, request, status, shot_index, source_job_id, root_job_id,"
                " output_url, provider_snapshot, duration_ms, created_at, updated_at, finished_at)"
                " SELECT :id, owner_user_id, :conversation_id, :kind, :operation, 'local',"
                " CAST(:request AS jsonb), :status, shot_index, :edit, :base, :output_url,"
                " '{}'::jsonb, :duration_ms, :created_at, :created_at, :created_at"
                " FROM iclip.generation_jobs WHERE id = :base"
            ),
            {
                "id": composite_id,
                "conversation_id": conversation_id,
                "kind": KIND_VIDEO,
                "operation": OPERATION_COMPOSE,
                "request": json.dumps(
                    {"segments": [{"url": url(f"{url_name}-edit"), "start": 0, "end": 3}]}
                ),
                "status": STATUS_COMPLETED,
                "edit": edit_id,
                "base": base,
                "output_url": url(url_name),
                "duration_ms": duration_ms,
                "created_at": created_at,
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


async def test_one_card_per_shot_with_failures_derivatives_and_deletions_left_out(
    reports: PgLibraryReports, seed: Seed
) -> None:
    rows = await reports.videos(Scope(), limit=20, after=None)

    cards = [(row.video.id, row.video.take_count, row.video.face.kind) for row in rows]
    # 卡面时刻倒序：G 120、N 100（c1 镜 1，卡面那次出片是 A）、E 40、D 30、H 10
    assert cards == [
        (seed.g, 1, "take"),
        (seed.a, 2, "master"),
        (seed.e, 1, "take"),
        (seed.d, 1, "take"),
        (seed.h, 1, "take"),
    ]
    assert await reports.count(Scope()) == 5


async def test_the_master_is_the_face_and_the_take_keeps_its_own_script(
    reports: PgLibraryReports, seed: Seed
) -> None:
    """成片按原作号挂到那次出片上：在分叉副本里剪的 N 也是 A 的一版，比 M 晚，成了卡面。"""

    row = await reports.card_of(seed.b)

    assert row is not None
    video = row.video
    assert video.id == seed.a and video.shot_index == 1
    assert video.face.job_id == seed.n and video.face.output_url == url("n")
    assert video.face.watermark_output_url is None
    assert video.face.duration_ms == 6500 and video.face.created_at == at(100)
    assert video.title == "春夏凉鞋合集" and video.agent_id == "storyboard"
    assert row.conversation_owner == seed.nina and video.conversation_id == seed.c1
    assert video.take.script is not None
    assert [cut.prompt for cut in video.take.script.timeline] == [
        "空地面停一拍。",
        "踩入 @Image1 夹趾凉鞋。",
    ]
    assert [master.output_url for master in video.take.masters] == [url("m"), url("n")]


async def test_takes_of_a_shot_come_oldest_first_with_parsed_and_plain_scripts(
    reports: PgLibraryReports, seed: Seed
) -> None:
    takes = await reports.takes_of(seed.a)

    assert [take.id for take in takes] == [seed.a, seed.b]
    parsed = takes[1].script
    assert parsed is not None
    assert parsed.global_settings == "浅灰地面与白墙。"
    assert [(cut.start, cut.end, cut.image_indexes) for cut in parsed.timeline] == [
        (0, 4, [1]),
        (4, 8, []),
    ]
    assert takes[1].prompt == MARKER_PROMPT

    plain = await reports.card_of(seed.h)
    assert plain is not None and plain.video.take.script is None
    assert plain.video.conversation_id is None and plain.video.title is None
    assert plain.video.take.user_name == SHAN


async def test_siblings_are_the_other_shots_of_the_same_conversation(
    reports: PgLibraryReports, seed: Seed
) -> None:
    assert [row.video.id for row in await reports.siblings_of(seed.b)] == [seed.d]
    assert await reports.siblings_of(seed.h) == []


async def test_things_outside_the_library_have_no_card(
    reports: PgLibraryReports, seed: Seed
) -> None:
    for outside in (seed.c, seed.f, seed.n, uuid.uuid4()):
        assert await reports.card_of(outside) is None
        assert await reports.takes_of(outside) == []


async def test_filters_by_person_orientation_window_and_keyword(
    reports: PgLibraryReports, seed: Seed
) -> None:
    async def ids(scope: Scope) -> list[uuid.UUID]:
        return [row.video.id for row in await reports.videos(scope, limit=20, after=None)]

    assert await ids(Scope(user_name=LEO)) == [seed.g, seed.e]
    assert await ids(Scope(orientation="landscape")) == [seed.h]
    assert seed.h not in await ids(Scope(orientation="portrait"))
    # 时间窗作用在卡面时刻上：c1 镜 1 的卡面是 100 分钟时的成片
    assert await ids(Scope(since=at(95), until=at(110))) == [seed.a]
    assert await ids(Scope(q="凉鞋合集")) == [seed.g, seed.a, seed.d]
    assert await ids(Scope(q="100%")) == [seed.e]
    assert await ids(Scope(q="100_")) == []
    assert await reports.count(Scope(user_name=NINA)) == 2


async def test_authors_count_cards_per_person(reports: PgLibraryReports, seed: Seed) -> None:
    authors = [(author.user_name, author.count) for author in await reports.authors()]

    assert authors == [(LEO, 2), (NINA, 2), (SHAN, 1)]


async def test_keyset_pages_do_not_overlap(reports: PgLibraryReports, seed: Seed) -> None:
    first = await reports.videos(Scope(), limit=2, after=None)
    last = first[-1].video
    second = await reports.videos(
        Scope(), limit=10, after=VideoCursor(at=last.face.created_at, video_id=last.id)
    )

    assert [row.video.id for row in first] == [seed.g, seed.a]
    assert [row.video.id for row in second] == [seed.e, seed.d, seed.h]
