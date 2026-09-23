"""审计报表的 Postgres 查询：按合同 §12 的口径，用一套手工种下的数据核每一格。

数据用原生 SQL 直插，时间戳自己定（业务仓储都用数据库时钟，控不住时刻）。基准时刻
``BASE`` 是测试开始的此刻，空转 / 悬挂两种异常靠 ``now()`` 判，样本都往过去放。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.domains.audit.models import (
    AnomalyCursor,
    ConversationCursor,
    Scope,
    Thresholds,
)
from iclip.domains.audit.reports_pg import PgAuditReports
from iclip.domains.generation.models import STATUS_COMPLETED, STATUS_FAILED, STATUS_SUBMITTED
from iclip.domains.generation.schemas import KIND_VIDEO
from tests.helpers.pg import reset_database

BASE = datetime.now(UTC).replace(microsecond=0)
SHAN = "Shan.Hu"
DONNIE = "Donnie.Liu"
EDNA = "Edna.Li"


def ago(**delta: float) -> datetime:
    return BASE - timedelta(**delta)


class Seed:
    """一组固定的数据：三个人（一个只跑过没出片）、两张需求单、八段对话、八条带镜号的视频与一条没镜号的。"""

    def __init__(self) -> None:
        self.shan = uuid.uuid4()
        self.donnie = uuid.uuid4()
        self.task = uuid.uuid4()
        self.stuck_task = uuid.uuid4()
        self.c1 = uuid.uuid4()  # 需求单下、两镜、镜 2 试了三次
        self.c2 = uuid.uuid4()  # 需求单下、钥匙直提没有运行、镜 2 悬挂在上游
        self.c3 = uuid.uuid4()  # 没挂需求单的成片
        self.c4 = uuid.uuid4()  # 有运行无成片、两天没动
        self.c5 = uuid.uuid4()  # 已删
        self.c1_agent_job_at = ago(hours=2)
        self.c2_created_at = ago(hours=5)
        self.missing_shot_video = uuid.uuid4()
        self.stuck_video = uuid.uuid4()

    async def plant(self, engine: AsyncEngine) -> None:
        async with engine.begin() as conn:
            for user_id, name in ((self.shan, SHAN), (self.donnie, DONNIE)):
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
            for task_id, title in ((self.task, "夏季连衣裙"), (self.stuck_task, "卡住的单")):
                await conn.execute(
                    text(
                        "INSERT INTO iclip.tasks (id, title, status, priority, creator_user_id,"
                        " inputs, created_at, updated_at)"
                        " VALUES (:id, :title, 'draft', 0, :creator, '{}'::jsonb, :at, :at)"
                    ),
                    {"id": task_id, "title": title, "creator": self.shan, "at": ago(days=3)},
                )

            async def conversation(
                conversation_id: uuid.UUID,
                *,
                owner: uuid.UUID,
                task_id: uuid.UUID | None,
                created_at: datetime,
                updated_at: datetime,
                deleted_at: datetime | None = None,
            ) -> None:
                await conn.execute(
                    text(
                        "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title,"
                        " task_id, created_at, updated_at, deleted_at)"
                        " VALUES (:id, :owner, 'agent', :title, :task_id, :created_at,"
                        " :updated_at, :deleted_at)"
                    ),
                    {
                        "id": conversation_id,
                        "owner": owner,
                        "title": f"对话 {conversation_id}",
                        "task_id": task_id,
                        "created_at": created_at,
                        "updated_at": updated_at,
                        "deleted_at": deleted_at,
                    },
                )

            async def agent_job(
                conversation_id: uuid.UUID, *, user_name: str, at: datetime
            ) -> None:
                await conn.execute(
                    text(
                        "INSERT INTO agent_runtime.agent_jobs (prompt_id, conversation_id, agent_id,"
                        " owner_user_id, user_name, content, status, created_at, finished_at)"
                        " VALUES (:prompt_id, :conversation_id, 'agent', :owner, :user_name, '',"
                        " 'done', :at, :at)"
                    ),
                    {
                        "prompt_id": str(uuid.uuid4()),
                        "conversation_id": str(conversation_id),
                        "owner": self.shan,
                        "user_name": user_name,
                        "at": at,
                    },
                )

            async def video(
                conversation_id: uuid.UUID,
                *,
                user_name: str,
                shot: int | None,
                status: str,
                created_at: datetime,
                submitted_at: datetime | None = None,
                finished_at: datetime | None = None,
                video_id: uuid.UUID | None = None,
                metadata: dict[str, object] | None = None,
                root_job_id: uuid.UUID | None = None,
            ) -> None:
                if metadata is None and shot is not None:
                    metadata = {"shot": shot}
                await conn.execute(
                    text(
                        "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id,"
                        " kind, provider, request, status, metadata, root_job_id, created_at,"
                        " updated_at, submitted_at, finished_at)"
                        " VALUES (:id, :owner, :conversation_id, :kind, 'test',"
                        " CAST(:request AS jsonb), :status, CAST(:metadata AS jsonb),"
                        " :root_job_id, :created_at, :created_at, :submitted_at, :finished_at)"
                    ),
                    {
                        "id": video_id or uuid.uuid4(),
                        "kind": KIND_VIDEO,
                        "owner": self.shan,
                        "conversation_id": conversation_id,
                        "request": json.dumps(
                            {"model": "m", "prompt": "p", "user_name": user_name}
                        ),
                        "status": status,
                        "metadata": None if metadata is None else json.dumps(metadata),
                        "root_job_id": root_job_id,
                        "created_at": created_at,
                        "submitted_at": submitted_at,
                        "finished_at": finished_at,
                    },
                )

            async def usage(
                conversation_id: uuid.UUID,
                model: str,
                *,
                requests: int,
                input_tokens: int,
                cache_read: int,
                cache_write: int,
                output: int,
                last_at: datetime,
            ) -> None:
                await conn.execute(
                    text(
                        "INSERT INTO agent_runtime.conversation_usage (conversation_id, model_name,"
                        " requests, input_tokens, cache_read_tokens, cache_write_tokens,"
                        " output_tokens, first_at, last_at)"
                        " VALUES (:conversation_id, :model, :requests, :input_tokens, :cache_read,"
                        " :cache_write, :output, :last_at, :last_at)"
                    ),
                    {
                        "conversation_id": str(conversation_id),
                        "model": model,
                        "requests": requests,
                        "input_tokens": input_tokens,
                        "cache_read": cache_read,
                        "cache_write": cache_write,
                        "output": output,
                        "last_at": last_at,
                    },
                )

            # C1：Shan 在需求单下聊了一轮，镜 1 成了又重出一条（也成了），镜 2 失败一次、成两次；
            # 另有一条没镜号。两镜都不算一次通过。
            await conversation(
                self.c1,
                owner=self.shan,
                task_id=self.task,
                created_at=ago(hours=3),
                updated_at=ago(minutes=40),
            )
            await agent_job(self.c1, user_name=SHAN, at=self.c1_agent_job_at)
            await video(
                self.c1,
                user_name=SHAN,
                shot=1,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=100),
                submitted_at=ago(minutes=99),
                finished_at=ago(minutes=90),
            )
            await video(
                self.c1,
                user_name=SHAN,
                shot=1,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=95),
                submitted_at=ago(minutes=94),
                finished_at=ago(minutes=85),
            )
            await video(
                self.c1,
                user_name=SHAN,
                shot=2,
                status=STATUS_FAILED,
                created_at=ago(minutes=80),
                finished_at=ago(minutes=75),
            )
            await video(
                self.c1,
                user_name=SHAN,
                shot=2,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=70),
                submitted_at=ago(minutes=69),
                finished_at=ago(minutes=60),
            )
            await video(
                self.c1,
                user_name=SHAN,
                shot=2,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=50),
                submitted_at=ago(minutes=49),
                finished_at=ago(minutes=40),
            )
            await video(
                self.c1,
                user_name=SHAN,
                shot=None,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=10),
                finished_at=ago(minutes=5),
                video_id=self.missing_shot_video,
            )
            # 视频编辑的结果：衍生记录没有镜头组，不算出片、也不算缺坐标。
            await video(
                self.c1,
                user_name=SHAN,
                shot=None,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=8),
                finished_at=ago(minutes=4),
                root_job_id=self.missing_shot_video,
                metadata={
                    "baseJob": str(self.missing_shot_video),
                    "editId": "e1",
                    "editStart": 1,
                    "editEnd": 4,
                },
            )
            await usage(
                self.c1,
                "m-a",
                requests=4,
                input_tokens=1000,
                cache_read=500,
                cache_write=100,
                output=200,
                last_at=ago(minutes=45),
            )
            await usage(
                self.c1,
                "m-b",
                requests=1,
                input_tokens=100,
                cache_read=0,
                cache_write=0,
                output=50,
                last_at=ago(minutes=44),
            )

            # C2：Donnie 用钥匙直提，没有运行；镜 1 成了，镜 2 三小时前提交上游至今没结果。
            await conversation(
                self.c2,
                owner=self.donnie,
                task_id=self.task,
                created_at=self.c2_created_at,
                updated_at=ago(hours=3),
            )
            await video(
                self.c2,
                user_name=DONNIE,
                shot=1,
                status=STATUS_COMPLETED,
                created_at=ago(hours=4),
                submitted_at=ago(hours=4) + timedelta(minutes=1),
                finished_at=ago(hours=3),
            )
            await video(
                self.c2,
                user_name=DONNIE,
                shot=2,
                status=STATUS_SUBMITTED,
                created_at=ago(hours=3),
                submitted_at=ago(hours=3),
                video_id=self.stuck_video,
            )

            # C3：Shan 没挂需求单也出了片。
            await conversation(
                self.c3,
                owner=self.shan,
                task_id=None,
                created_at=ago(hours=30),
                updated_at=ago(hours=28),
            )
            await agent_job(self.c3, user_name=SHAN, at=ago(hours=29))
            await video(
                self.c3,
                user_name=SHAN,
                shot=1,
                status=STATUS_COMPLETED,
                created_at=ago(hours=29),
                submitted_at=ago(hours=29) + timedelta(minutes=1),
                finished_at=ago(hours=28),
            )
            await usage(
                self.c3,
                "m-a",
                requests=2,
                input_tokens=300,
                cache_read=100,
                cache_write=0,
                output=60,
                last_at=ago(hours=28),
            )

            # C4：跑过、没出片、两天没动。
            await conversation(
                self.c4,
                owner=self.donnie,
                task_id=self.task,
                created_at=ago(hours=49),
                updated_at=ago(hours=48),
            )
            await agent_job(self.c4, user_name=DONNIE, at=ago(hours=49))

            # C5：Edna 替 Shan 跑了一轮就被属主删掉了；Edna 只有这一次运行，没有成片也没有用量。
            await conversation(
                self.c5,
                owner=self.shan,
                task_id=None,
                created_at=ago(hours=2),
                updated_at=ago(hours=1),
                deleted_at=ago(hours=1),
            )
            await agent_job(self.c5, user_name=EDNA, at=ago(minutes=90))

            # 卡住的单：三段对话都没出片，也没跑过。
            for _ in range(3):
                await conversation(
                    uuid.uuid4(),
                    owner=self.donnie,
                    task_id=self.stuck_task,
                    created_at=ago(hours=6),
                    updated_at=ago(hours=6),
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
def reports(engine: AsyncEngine) -> PgAuditReports:
    return PgAuditReports(engine)


async def test_overall_counts_every_metric_on_its_own_anchor(
    reports: PgAuditReports, seed: Seed
) -> None:
    """成片件数按「需求单一件、无单对话一件」；镜含失败与悬挂的尝试，成了又重出的不算一次通过；
    运行含已删对话的；周期缺运行时从对话创建起算。"""

    overall = await reports.overall(Scope())

    assert overall.completed_videos == 6
    assert (overall.delivered_tasks, overall.delivered_orphan_conversations) == (1, 1)
    assert overall.deliveries == 2
    assert overall.producers == 2
    assert (overall.shots, overall.attempts, overall.one_take_shots) == (5, 8, 2)
    assert overall.attempts_per_shot == pytest.approx(8 / 5)
    assert overall.one_take_rate == pytest.approx(2 / 5)
    assert overall.runs == 4
    assert overall.delivered_conversations == 3
    assert overall.cycle_seconds is not None
    assert (overall.cycle_seconds.avg, overall.cycle_seconds.median) == (5200, 4800)
    assert overall.cycle_seconds.p90 == pytest.approx(6720)
    assert overall.video_seconds is not None
    assert (overall.video_seconds.avg, overall.video_seconds.median, overall.video_seconds.p90) == (
        1600,
        600,
        3600,
    )
    assert overall.upstream_seconds is not None
    assert overall.upstream_seconds.avg == 1540
    assert (
        overall.usage.requests,
        overall.usage.input_tokens,
        overall.usage.cache_read_tokens,
        overall.usage.cache_write_tokens,
        overall.usage.output_tokens,
    ) == (7, 1400, 600, 100, 310)
    assert overall.usage.cache_hit_rate == pytest.approx(600 / 2100)
    assert overall.tokens_per_delivery == 2410 / 2


async def test_window_applies_to_each_metric_anchor(reports: PgAuditReports, seed: Seed) -> None:
    """近两小时：只剩 C1 的四条成片、两镜、一段周期与两行用量；运行数左闭，恰在 since 的 C1 那轮算进来。"""

    recent = await reports.overall(Scope(since=ago(hours=2)))

    assert recent.completed_videos == 4
    assert (recent.delivered_tasks, recent.delivered_orphan_conversations) == (1, 0)
    assert (recent.shots, recent.attempts, recent.one_take_shots) == (2, 5, 0)
    assert recent.runs == 2
    assert recent.delivered_conversations == 1
    assert recent.cycle_seconds is not None and recent.cycle_seconds.avg == 4800
    assert recent.usage.requests == 5


async def test_empty_scope_is_all_zeros(reports: PgAuditReports, seed: Seed) -> None:
    nothing = await reports.overall(Scope(user_name="Nobody"))

    assert nothing.completed_videos == 0
    assert nothing.deliveries == 0
    assert nothing.cycle_seconds is None
    assert nothing.usage.requests == 0


async def test_attempt_distribution_buckets_shots_by_their_attempt_count(
    reports: PgAuditReports, seed: Seed
) -> None:
    """五个镜分三档：三个一次的、一个两次的、一个三次的。次数含失败与悬挂的尝试，
    窗口与筛选跟每镜次数同锚点，看该镜首次出片时刻。"""

    everything = await reports.attempt_distribution(Scope())
    recent = await reports.attempt_distribution(Scope(since=ago(hours=2)))
    by_donnie = await reports.attempt_distribution(Scope(user_name=DONNIE))
    nobody = await reports.attempt_distribution(Scope(user_name="Nobody"))

    assert [(row.attempts, row.shots) for row in everything] == [(1, 3), (2, 1), (3, 1)]
    assert [(row.attempts, row.shots) for row in recent] == [(2, 1), (3, 1)]
    assert [(row.attempts, row.shots) for row in by_donnie] == [(1, 2)]
    assert nobody == []


async def test_by_user_attributes_videos_by_request_and_conversations_by_latest_run(
    reports: PgAuditReports, seed: Seed
) -> None:
    """视频归 ``request.user_name``；对话归最近一轮运行的人，没跑过就归最近一条视频的人；
    运行归发起人，只跑过没出片的人也占一行。"""

    rows = await reports.by_user(Scope())

    assert [row.user_name for row in rows] == [SHAN, DONNIE, EDNA]
    shan, donnie, edna = (row.metrics for row in rows)
    assert (shan.completed_videos, shan.deliveries) == (5, 2)
    assert (shan.shots, shan.attempts, shan.one_take_shots) == (3, 6, 1)
    assert shan.runs == 2
    assert shan.delivered_conversations == 2
    assert shan.usage.requests == 7
    assert (donnie.completed_videos, donnie.deliveries) == (1, 1)
    assert (donnie.shots, donnie.attempts, donnie.one_take_shots) == (2, 2, 1)
    assert donnie.runs == 1
    assert donnie.delivered_conversations == 1
    assert donnie.cycle_seconds is not None and donnie.cycle_seconds.avg == 7200
    assert donnie.usage.requests == 0
    assert (edna.runs, edna.deliveries, edna.shots, edna.usage.requests) == (1, 0, 0, 0)
    assert edna.cycle_seconds is None


async def test_by_task_lists_only_tasks_with_activity(reports: PgAuditReports, seed: Seed) -> None:
    """没挂需求单的对话不在这里；卡住的单没有任何视频、运行或用量，也不出现。"""

    rows = await reports.by_task(Scope())

    assert [(row.task_id, row.title) for row in rows] == [(seed.task, "夏季连衣裙")]
    task = rows[0].metrics
    assert (task.completed_videos, task.deliveries, task.producers) == (5, 1, 2)
    assert (task.shots, task.attempts, task.one_take_shots) == (4, 7, 1)
    assert task.runs == 2
    assert task.delivered_conversations == 2
    assert task.usage.requests == 5


async def test_by_period_buckets_in_the_given_timezone(reports: PgAuditReports, seed: Seed) -> None:
    shanghai = ZoneInfo("Asia/Shanghai")

    rows = await reports.by_period(Scope(), bucket="day", timezone="Asia/Shanghai")

    assert rows and all(row.period_start.astimezone(shanghai).hour == 0 for row in rows)
    assert [row.period_start for row in rows] == sorted(row.period_start for row in rows)
    assert sum(row.metrics.completed_videos for row in rows) == 6
    assert sum(row.metrics.shots for row in rows) == 5
    assert sum(row.metrics.runs for row in rows) == 4
    assert sum(row.metrics.delivered_conversations for row in rows) == 3
    assert sum(row.metrics.usage.requests for row in rows) == 7


async def test_by_period_fills_every_bucket_of_a_bounded_window(
    reports: PgAuditReports, seed: Seed
) -> None:
    """有界时间窗内每一期都占一行，没动静的期计数为 0、分布为空；不限时间只列有数据的期。"""

    shanghai = ZoneInfo("Asia/Shanghai")
    since = ago(days=3)

    rows = await reports.by_period(Scope(since=since), bucket="day", timezone="Asia/Shanghai")

    starts = [row.period_start.astimezone(shanghai) for row in rows]
    assert len(starts) == 4
    assert starts[0].date() == since.astimezone(shanghai).date()
    assert all(later - earlier == timedelta(days=1) for earlier, later in pairwise(starts))
    assert sum(row.metrics.completed_videos for row in rows) == 6
    assert sum(row.metrics.runs for row in rows) == 4
    quiet = [row.metrics for row in rows if row.metrics.completed_videos == 0]
    assert all(m.cycle_seconds is None and m.video_seconds is None for m in quiet)

    sparse = await reports.by_period(Scope(), bucket="day", timezone="Asia/Shanghai")

    assert len(sparse) <= len(rows)
    assert all(
        row.metrics.completed_videos
        or row.metrics.shots
        or row.metrics.runs
        or row.metrics.usage.requests
        for row in sparse
    )


async def test_conversations_carry_whole_conversation_detail_and_page_by_cursor(
    reports: PgAuditReports, seed: Seed
) -> None:
    first_page = await reports.conversations(Scope(), limit=2, after=None)

    assert [row.conversation_id for row in first_page] == [seed.c1, seed.c2]
    c1, c2 = first_page
    assert (c1.user_name, c1.task_id, c1.started_at) == (SHAN, seed.task, seed.c1_agent_job_at)
    assert c1.delivered_at == ago(minutes=40)
    assert (c1.metrics.completed_videos, c1.metrics.runs) == (4, 1)
    assert c1.metrics.cycle_seconds is not None and c1.metrics.cycle_seconds.avg == 4800
    assert [(shot.shot, shot.attempts, shot.one_take) for shot in c1.shots] == [
        (1, 2, False),
        (2, 3, False),
    ]
    assert [(item.model_name, item.usage.requests) for item in c1.usage] == [("m-a", 4), ("m-b", 1)]
    assert (c2.user_name, c2.started_at) == (DONNIE, seed.c2_created_at)
    assert [(shot.shot, shot.attempts, shot.one_take) for shot in c2.shots] == [
        (1, 1, True),
        (2, 1, False),
    ]
    assert c2.usage == []

    second_page = await reports.conversations(
        Scope(),
        limit=2,
        after=ConversationCursor(delivered_at=c2.delivered_at, conversation_id=c2.conversation_id),
    )

    assert [row.conversation_id for row in second_page] == [seed.c3]
    assert second_page[0].task_id is None
    assert second_page[0].metrics.delivered_orphan_conversations == 1


async def test_conversations_window_and_filters(reports: PgAuditReports, seed: Seed) -> None:
    recent = await reports.conversations(Scope(since=ago(hours=2)), limit=10, after=None)
    by_donnie = await reports.conversations(Scope(user_name=DONNIE), limit=10, after=None)
    in_task = await reports.conversations(Scope(task_id=seed.task), limit=10, after=None)

    assert [row.conversation_id for row in recent] == [seed.c1]
    assert [row.conversation_id for row in by_donnie] == [seed.c2]
    assert [row.conversation_id for row in in_task] == [seed.c1, seed.c2]


async def test_anomalies_flag_every_agreed_kind(reports: PgAuditReports, seed: Seed) -> None:
    """九种异常各出一条；P90 / P95 门槛按范围现算，三段周期里最长的那段、两罐里多的那罐被标出。"""

    found = await reports.anomalies(Scope(), Thresholds(), kinds=None, limit=50, after=None)

    by_kind = {item.kind: item for item in found}
    assert len(found) == len(by_kind) == 9
    assert [item.at for item in found] == sorted((item.at for item in found), reverse=True)

    retry = by_kind["retry"]
    assert (retry.conversation_id, retry.shot, retry.value, retry.threshold) == (seed.c1, 2, 3, 2)
    assert (retry.user_name, retry.task_id) == (SHAN, seed.task)

    idle = by_kind["idle"]
    assert (idle.conversation_id, idle.user_name) == (seed.c4, DONNIE)
    assert idle.value is not None and idle.value > 47 and idle.threshold == 24

    slow = by_kind["slow"]
    assert (slow.conversation_id, slow.value) == (seed.c2, 7200)
    assert slow.threshold == pytest.approx(6720)

    stuck = by_kind["stuck"]
    assert (stuck.generation_id, stuck.conversation_id, stuck.shot) == (
        seed.stuck_video,
        seed.c2,
        2,
    )
    assert stuck.value is not None and stuck.value > 2.9 and stuck.threshold == 1

    spend = by_kind["spend"]
    assert (spend.conversation_id, spend.value) == (seed.c1, 1950)

    task_stuck = by_kind["task_stuck"]
    assert (task_stuck.task_id, task_stuck.value, task_stuck.threshold) == (seed.stuck_task, 3, 3)

    assert by_kind["deleted"].conversation_id == seed.c5
    assert by_kind["deleted"].value == 0
    assert (by_kind["no_task"].conversation_id, by_kind["no_task"].value) == (seed.c3, 1)
    missing = by_kind["missing_shot"]
    assert (missing.generation_id, missing.conversation_id, missing.user_name) == (
        seed.missing_shot_video,
        seed.c1,
        SHAN,
    )


async def test_anomalies_filter_by_kind_and_page_by_cursor(
    reports: PgAuditReports, seed: Seed
) -> None:
    only_retry = await reports.anomalies(
        Scope(), Thresholds(), kinds=["retry"], limit=50, after=None
    )
    assert [item.kind for item in only_retry] == ["retry"]

    lenient = await reports.anomalies(
        Scope(), Thresholds(retry_over=3), kinds=["retry"], limit=50, after=None
    )
    assert lenient == []

    first = await reports.anomalies(Scope(), Thresholds(), kinds=None, limit=4, after=None)
    rest = await reports.anomalies(
        Scope(),
        Thresholds(),
        kinds=None,
        limit=50,
        after=AnomalyCursor(at=first[-1].at, ref=first[-1].ref),
    )
    assert len(first) == 4 and len(rest) == 5
    assert {item.ref for item in first}.isdisjoint(item.ref for item in rest)


async def test_anomalies_respect_scope_filters(reports: PgAuditReports, seed: Seed) -> None:
    by_donnie = await reports.anomalies(
        Scope(user_name=DONNIE), Thresholds(), kinds=None, limit=50, after=None
    )
    in_task = await reports.anomalies(
        Scope(task_id=seed.task), Thresholds(), kinds=None, limit=50, after=None
    )

    # P90 / P95 按筛选后的样本算：Donnie 只有一段周期，谁都不算慢；需求单里两段周期，
    # 长的那段超过 P90；用量只有 C1 一罐，超不过自己的 P95。
    assert {item.kind for item in by_donnie} == {"idle", "stuck"}
    assert {item.kind for item in in_task} == {"retry", "idle", "slow", "stuck", "missing_shot"}


async def test_anomaly_counts_share_the_anomaly_judgement(
    reports: PgAuditReports, seed: Seed
) -> None:
    """计数与列表同一套判定：全范围九种各一条，筛到 Donnie 只剩空转与悬挂，放宽阈值就少一种；同数按种类名排。"""

    everything = await reports.anomaly_counts(Scope(), Thresholds())
    by_donnie = await reports.anomaly_counts(Scope(user_name=DONNIE), Thresholds())
    lenient = await reports.anomaly_counts(Scope(), Thresholds(retry_over=3))

    assert {(row.kind, row.count) for row in everything} == {
        (kind, 1)
        for kind in (
            "retry",
            "idle",
            "slow",
            "stuck",
            "spend",
            "task_stuck",
            "deleted",
            "no_task",
            "missing_shot",
        )
    }
    assert [row.kind for row in everything] == sorted(row.kind for row in everything)
    assert [(row.kind, row.count) for row in by_donnie] == [("idle", 1), ("stuck", 1)]
    assert "retry" not in {row.kind for row in lenient}


async def test_forks_do_not_count_toward_any_metric(
    reports: PgAuditReports, seed: Seed, engine: AsyncEngine
) -> None:
    """副本带着源对话拷来的出片记录，算进去会把原作者的产量重计一遍；它自己跑的也是试验数据。"""

    before = await reports.overall(Scope())
    fork_id = uuid.uuid4()
    at = ago(hours=1)
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, task_id,"
                " created_at, updated_at, forked_from, fork_turn)"
                " VALUES (:id, :owner, 'agent', '副本', :task_id, :at, :at, :source, 1)"
            ),
            {"id": fork_id, "owner": seed.shan, "task_id": seed.task, "at": at, "source": seed.c1},
        )
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, metadata,"
                " kind, provider, request, status, output_url, created_at, updated_at,"
                " submitted_at, finished_at)"
                " VALUES (:id, :owner, :conversation_id, :metadata, :kind, 'p',"
                " :request, :status, 'https://example.test/copy.mp4', :at, :at, :at, :at)"
            ),
            {
                "id": uuid.uuid4(),
                "owner": seed.shan,
                "conversation_id": fork_id,
                "metadata": json.dumps({"shot": 1}),
                "kind": KIND_VIDEO,
                "status": STATUS_COMPLETED,
                "request": json.dumps({"kind": "video", "user_name": SHAN}),
                "at": at,
            },
        )
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.agent_jobs (prompt_id, conversation_id, agent_id,"
                " owner_user_id, user_name, content, status, created_at, finished_at)"
                " VALUES (:prompt_id, :conversation_id, 'agent', :owner, :user_name, '',"
                " 'done', :at, :at)"
            ),
            {
                "prompt_id": str(uuid.uuid4()),
                "conversation_id": str(fork_id),
                "owner": seed.shan,
                "user_name": SHAN,
                "at": at,
            },
        )
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.conversation_usage (conversation_id, model_name,"
                " requests, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,"
                " first_at, last_at)"
                " VALUES (:conversation_id, 'test-model', 9, 900, 90, 9, 90, :at, :at)"
            ),
            {"conversation_id": str(fork_id), "at": at},
        )

    after = await reports.overall(Scope())
    assert after == before
