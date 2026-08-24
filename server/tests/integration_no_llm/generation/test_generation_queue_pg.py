"""T-GEN-07：真库上的排期——排进去、被消费掉、跑到终态。

单测里连接器是内存的，验的是我们的判断；这一条验的是**装配对不对**：DSN 换驱动换对
了没有、建表迁移跟这个库版本合得上没有、进程内起 worker 能不能真的把活干完。这几样
一旦错了，单测全绿而线上一个任务都不动。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator
from typing import Protocol

import procrastinate
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTING,
)
from iclip.domains.generation.provider import ProviderSubmission
from iclip.domains.generation.queue import (
    QUEUE_SUBMIT_IMAGE,
    GenerationQueue,
    GenerationQueueSettings,
    queue_dsn,
)
from tests.helpers.generation import ScriptedProvider, image_request, make_job, video_request

# 间隔全压到秒级：这里验的是「走不走得通」，不是那几个默认值多大。
SETTINGS = GenerationQueueSettings(
    poll_interval_seconds=1, error_retry_seconds=2, shutdown_grace_seconds=2
)


class QueueFactory(Protocol):
    """造一个连着真库的 queue；用完由夹具收连接。"""

    async def __call__(
        self, *, video: ScriptedProvider, image: ScriptedProvider
    ) -> GenerationQueue: ...


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    created = create_async_engine(migrated_pg)
    async with created.begin() as conn:
        await conn.execute(
            text("TRUNCATE iclip.api_keys, iclip.oauth_accounts, iclip.users CASCADE")
        )
        # 上一条测试留下的排期不该影响这一条。worker 行也要清：它留着的话，这一条
        # 里「心跳还新鲜时谁都不许动」会被上一条留下的失联 worker 弄假。
        await conn.execute(text("TRUNCATE procrastinate_jobs, procrastinate_workers CASCADE"))
    try:
        yield created
    finally:
        await created.dispose()


@pytest.fixture
async def queue_factory(engine: AsyncEngine, migrated_pg: str) -> AsyncGenerator[QueueFactory]:
    """造一个连着真库的 ``GenerationQueue``，用完把连接收干净。"""

    opened: list[GenerationQueue] = []

    async def make(*, video: ScriptedProvider, image: ScriptedProvider) -> GenerationQueue:
        queue = GenerationQueue(
            SqlGenerationRepository(engine),
            providers={"video": video, "image": image},  # type: ignore[arg-type]
            connector=procrastinate.PsycopgConnector(conninfo=queue_dsn(migrated_pg)),
            settings=SETTINGS,
        )
        await queue.app.open_async()
        opened.append(queue)
        return queue

    try:
        yield make
    finally:
        for queue in opened:
            await queue.stop()
            await queue.app.close_async()


async def make_user(engine: AsyncEngine) -> uuid.UUID:
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


async def _submit_task_statuses(engine: AsyncEngine) -> list[str]:
    """提交任务在 procrastinate 那边的状态。只看这一种任务：同一张表里还有 healer
    自己每分钟排进来的行，把它算进来就会让断言随着「这次跑了多久」变来变去。"""

    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT status::text FROM procrastinate_jobs"
                " WHERE task_name = 'generation.submit' ORDER BY id"
            )
        )
    return list(rows.scalars().all())


async def wait_for_status(
    repo: SqlGenerationRepository, job_id: uuid.UUID, expected: str, *, timeout: float = 20.0
) -> None:
    """等那一行走到某个状态；超时就把它当时的样子报出来。"""

    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    status = ""
    while loop.time() < deadline:
        row = await repo.get(job_id, owner=None)
        status = row.status
        if status == expected:
            return
        await asyncio.sleep(0.1)
    raise AssertionError(f"等 {expected} 超时，现在是 {status}")


def test_dsn_drops_the_sqlalchemy_dialect_suffix() -> None:
    """``+asyncpg`` 只有 SQLAlchemy 认，psycopg 会拿它当主机名的一部分。"""

    assert queue_dsn("postgresql+asyncpg://u:p@h:5432/db") == "postgresql://u:p@h:5432/db"
    assert queue_dsn("postgresql://u:p@h:5432/db") == "postgresql://u:p@h:5432/db"


async def test_a_synchronous_generation_runs_end_to_end(
    engine: AsyncEngine, queue_factory: QueueFactory
) -> None:
    """图片那家：排进去 → worker 领走 → 一步到终态。全程没人手动推。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await repo.create(make_job(image_request(), owner_user_id=owner))
    image = ScriptedProvider(
        submission=ProviderSubmission(
            provider_task_id="img-1",
            provider_status="succeeded",
            output_url="https://cdn.test/out.png",
        )
    )
    queue = await queue_factory(video=ScriptedProvider(), image=image)

    await queue.enqueue_submit(job)
    queue.start()
    await wait_for_status(repo, job.id, STATUS_COMPLETED)

    stored = await repo.get(job.id, owner=None)
    assert stored.output_url == "https://cdn.test/out.png"
    assert stored.provider_task_id == "img-1"
    assert stored.submitted_at is not None and stored.finished_at is not None


async def test_an_asynchronous_generation_runs_end_to_end(
    engine: AsyncEngine, queue_factory: QueueFactory
) -> None:
    """视频那家：提交 → 自动排一次轮询 → 轮到结果 → 终态。

    中间那一跳（``mark_submitted`` 之后自己排下一次轮询）是整条链上最容易断的地方：
    断了这一行就永远停在「等结果」，而且不报错。
    """

    from iclip.domains.generation.provider import ProviderProgress

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await repo.create(make_job(video_request(), owner_user_id=owner))
    video = ScriptedProvider(
        submission=ProviderSubmission(provider_task_id="v-1", provider_status="queued"),
        progress=ProviderProgress(
            outcome="succeeded",
            provider_status="succeeded",
            output_url="https://cdn.test/v.mp4",
        ),
    )
    queue = await queue_factory(video=video, image=ScriptedProvider())

    await queue.enqueue_submit(job)
    queue.start()
    await wait_for_status(repo, job.id, STATUS_COMPLETED)

    assert video.submit_calls == [job.id]
    assert video.poll_calls == [job.id]
    assert (await repo.get(job.id, owner=None)).output_url == "https://cdn.test/v.mp4"


async def test_a_restart_mid_submit_fails_the_row_honestly(
    engine: AsyncEngine, queue_factory: QueueFactory
) -> None:
    """整条不重投红线在真库上走一遍（优雅关停这一种，也就是发版）。

    提交被打断 → 那一行停在 ``submitting`` → 任务被重试策略重排 → 起来重跑 → 守卫看
    见 ``submitting``，照实判失败。**provider 一次都不许被再调一次**：两家接口都没有
    幂等键，重投就是重复付钱。
    """

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await repo.create(make_job(image_request(), owner_user_id=owner))

    entered = asyncio.Event()

    class Hanging(ScriptedProvider):
        async def submit(self, job_arg):  # type: ignore[no-untyped-def]
            self.submit_calls.append(job_arg.id)
            entered.set()
            await asyncio.sleep(3600)  # 代表一次十几分钟的图片生成
            raise AssertionError("不该走到这里")

    image = Hanging()
    queue = await queue_factory(video=ScriptedProvider(), image=image)
    await queue.enqueue_submit(job)
    queue.start()

    await asyncio.wait_for(entered.wait(), timeout=20)
    assert (await repo.get(job.id, owner=None)).status == STATUS_SUBMITTING

    # 发版：关停打断那次提交（宽限期 2 秒），那一行留在 submitting 上。
    await queue.stop()
    assert (await repo.get(job.id, owner=None)).status == STATUS_SUBMITTING

    # 新进程起来，重排回来的那个任务被重跑——这一次守卫说话。
    queue.start()
    await wait_for_status(repo, job.id, STATUS_FAILED, timeout=60)

    stored = await repo.get(job.id, owner=None)
    assert stored.error_code == "SUBMIT_INTERRUPTED"
    assert image.submit_calls == [job.id], "重跑了，但绝不能再提交一次"


async def test_a_hard_killed_worker_is_found_by_heartbeat(
    engine: AsyncEngine, queue_factory: QueueFactory
) -> None:
    """硬杀（SIGKILL / OOM / 机器没了）那一种：任务留在 doing 上，只能靠心跳发现。

    这一条打真库，因为验的是 ``select_stalled_jobs_by_heartbeat`` 那句真 SQL。

    **刻意不起 worker。** 硬杀留下的状态是「有人领了它，然后那个人再也不说话了」，
    用 job manager 直接摆出来就是了：领一次、把心跳拨到过去。起真 worker 反而验不
    准——它会在我们断言之前把捡回去的任务又领走一次，这条测试就时好时坏。真 worker
    跑通整条链的那两条在上面。
    """

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await repo.create(make_job(image_request(), owner_user_id=owner))

    queue = await queue_factory(video=ScriptedProvider(), image=ScriptedProvider())
    await queue.enqueue_submit(job)

    # 一个 worker 领走了它……
    worker_id = await queue.app.job_manager.register_worker()
    queued = await queue.app.job_manager.fetch_job(queues=[QUEUE_SUBMIT_IMAGE], worker_id=worker_id)
    assert queued is not None and queued.id is not None
    assert await _submit_task_statuses(engine) == ["doing"]

    # ……心跳还新鲜的时候，谁都不许动它：它可能正做着一次五分钟的生成。
    assert await queue.heal_stalled() == 0

    # ……然后它再也不说话了。
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE procrastinate_workers SET last_heartbeat = NOW() - INTERVAL '1 hour'")
        )
    assert await queue.heal_stalled() == 1
    assert await _submit_task_statuses(engine) == ["todo"], "捡回去重排，等着守卫来收尾"

    assert await _submit_task_statuses(engine) == ["todo"], "捡回去重排，等着守卫来收尾"
