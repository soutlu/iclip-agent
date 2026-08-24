"""T-GEN-06：真库上的状态跳转、属主可见性与那个状态守卫。

只留只能打真 Postgres 的那几条：时刻取的是不是数据库自己的时钟、请求体 JSON 往返、
外键级联，以及 ``only_if_status`` 的守卫——那是把 ``WHERE`` 塞进 ``UPDATE`` 来关掉
「先读后写」那道缝的，内存替身模拟不出它的原子性。

**领取与租约的测试没了**：排期归 procrastinate（见 ``queue.py``），这张表不再管待办。
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.common.errors import NotFound
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
)
from iclip.domains.generation.schemas import GenerationRequest
from tests.helpers.generation import image_request, make_job, video_request


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    created = create_async_engine(migrated_pg)
    async with created.begin() as conn:
        await conn.execute(
            text("TRUNCATE iclip.api_keys, iclip.oauth_accounts, iclip.users CASCADE")
        )
    try:
        yield created
    finally:
        await created.dispose()


async def make_user(engine: AsyncEngine) -> uuid.UUID:
    """generation_jobs 的属主是真外键，所以得先有个用户。"""

    user_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.users"
                " (id, email, hashed_password, is_active, is_superuser, is_verified,"
                "  display_name, avatar_url, roles, direct_permissions, city, job_title,"
                "  departments)"
                " VALUES (:id, :email, 'x', true, false, true, '', '',"
                " '[\"editor\"]'::jsonb, '[]'::jsonb, '', '', '[]'::jsonb)"
            ),
            {"id": user_id, "email": f"{user_id}@example.test"},
        )
    return user_id


async def insert_job(
    repo: SqlGenerationRepository,
    owner: uuid.UUID,
    request: GenerationRequest | None = None,
) -> GenerationJob:
    return await repo.create(make_job(request or video_request(), owner_user_id=owner))


async def test_timestamps_come_from_the_database_clock(engine: AsyncEngine) -> None:
    """时刻由数据库写，不是应用进程写——多台机器的时钟差几秒就对不上账了。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    stale = datetime.now(UTC) - timedelta(days=365)

    job = await repo.create(make_job(video_request(), owner_user_id=owner, created_at=stale))

    assert job.status == STATUS_PENDING
    assert job.created_at.tzinfo is not None
    assert job.created_at > stale + timedelta(days=1), "应用传进来的时刻被数据库改写了"
    assert job.submitted_at is None and job.finished_at is None


async def test_state_transitions_round_trip_through_the_table(engine: AsyncEngine) -> None:
    """整条状态链在真库上走一遍，顺便验请求体读回来还是原来那个形状。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    request = video_request(image_urls=["https://example.test/first.png"])
    job = await insert_job(repo, owner, request)

    assert (await repo.mark_submitting(job.id)).status == STATUS_SUBMITTING
    submitted = await repo.mark_submitted(
        job.id,
        provider_task_id="t-1",
        provider_status="queued",
        provider_snapshot={"task_id": "t-1"},
    )
    assert submitted.status == STATUS_SUBMITTED
    assert submitted.submitted_at is not None

    running = await repo.record_progress(
        job.id, provider_status="running", provider_snapshot={"status": "running"}
    )
    assert running.provider_status == "running"
    assert running.status == STATUS_SUBMITTED, "还在跑不改状态"

    completed = await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/v.mp4",
        provider_status="succeeded",
        provider_snapshot={"status": "succeeded"},
    )
    assert completed.finished_at is not None
    assert completed.submitted_at == submitted.submitted_at, "别把发出去的时刻改成拿到结果的时刻"
    assert completed.request == request, "请求体读回来必须还是原来那个"


async def test_sync_result_backfills_the_submitted_moment(engine: AsyncEngine) -> None:
    """同步接口一步到底，``submitted_at`` 只有这一步能填。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(job.id)
    completed = await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/out.png",
        provider_status="succeeded",
        provider_snapshot={},
        provider_task_id="img-1",
    )
    assert completed.provider_task_id == "img-1", "对账 id 错过这一步就永远没人写它"
    assert completed.submitted_at is not None


async def test_status_guard_never_overwrites_a_real_result(engine: AsyncEngine) -> None:
    """守卫塞在 ``WHERE`` 里，不是先读后写——那道缝正是要关掉的东西。

    场景：一行已经被写成成功（图生成了、钱付了），随后那个「提交中断」的收尾才动手。
    它必须落空，否则就是把一次已付费的成功盖成失败。
    """

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(job.id)
    await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/out.png",
        provider_status="succeeded",
        provider_snapshot={},
    )

    missed = await repo.mark_failed(
        job.id,
        error_code="SUBMIT_INTERRUPTED",
        error_message="不知道发出去没有",
        only_if_status=STATUS_SUBMITTING,
    )
    assert missed is None, "状态已经不是 submitting，这次写入必须一行都不动"

    stored = await repo.get(job.id, owner=owner)
    assert stored.status == STATUS_COMPLETED
    assert stored.output_url == "https://cdn.test/out.png"
    assert stored.error_code is None


async def test_status_guard_lets_the_write_through_when_it_matches(engine: AsyncEngine) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner)
    await repo.mark_submitting(job.id)

    failed = await repo.mark_failed(
        job.id,
        error_code="SUBMIT_INTERRUPTED",
        error_message="不知道发出去没有",
        only_if_status=STATUS_SUBMITTING,
    )
    assert failed is not None
    assert failed.status == STATUS_FAILED
    assert failed.error_code == "SUBMIT_INTERRUPTED"


async def test_reads_are_scoped_to_the_owner(engine: AsyncEngine) -> None:
    repo = SqlGenerationRepository(engine)
    mine = await make_user(engine)
    theirs = await make_user(engine)
    job = await insert_job(repo, theirs)

    with pytest.raises(NotFound):
        await repo.get(job.id, owner=mine)
    assert (await repo.get(job.id, owner=theirs)).id == job.id
    assert (await repo.get(job.id, owner=None)).id == job.id, "治理者视角不过滤"

    assert await repo.list_for_owner(owner=mine, limit=10) == ()
    assert len(await repo.list_for_owner(owner=None, limit=10)) == 1


async def test_deleting_the_owner_takes_their_generations_with_it(
    engine: AsyncEngine,
) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner)

    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM iclip.users WHERE id = :id"), {"id": owner})
    with pytest.raises(NotFound):
        await repo.get(job.id, owner=None)
