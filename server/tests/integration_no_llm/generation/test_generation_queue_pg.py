"""使用真实数据库与 worker 验证生成队列的驱动配置、迁移和状态推进。"""

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

# 缩短调度间隔以验证完整链路，默认间隔由配置测试覆盖。
SETTINGS = GenerationQueueSettings(
    poll_interval_seconds=1, error_retry_seconds=2, shutdown_grace_seconds=2
)


class QueueFactory(Protocol):
    """创建连接真实测试数据库的 queue，并在测试结束后关闭连接。"""

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
        # 清理任务及 worker，避免上一用例的失联心跳影响当前恢复判断。
        await conn.execute(text("TRUNCATE procrastinate_jobs, procrastinate_workers CASCADE"))
    try:
        yield created
    finally:
        await created.dispose()


@pytest.fixture
async def queue_factory(engine: AsyncEngine, migrated_pg: str) -> AsyncGenerator[QueueFactory]:
    """创建并关闭连接真实测试数据库的 GenerationQueue。"""

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
    """仅统计生成提交任务，排除 healer 周期任务以避免运行时长影响断言。"""

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
    """等待任务达到指定状态，超时时报告当前任务信息。"""

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

    assert queue_dsn("postgresql+asyncpg://u:p@h:5432/db") == "postgresql://u:p@h:5432/db"
    assert queue_dsn("postgresql://u:p@h:5432/db") == "postgresql://u:p@h:5432/db"


async def test_a_synchronous_generation_runs_end_to_end(
    engine: AsyncEngine, queue_factory: QueueFactory
) -> None:

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
    """优雅关停打断提交后，重排任务遇到 submitting 必须失败；供应商无幂等键，不能重复提交。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await repo.create(make_job(image_request(), owner_user_id=owner))

    entered = asyncio.Event()

    class Hanging(ScriptedProvider):
        async def submit(self, job_arg):  # type: ignore[no-untyped-def]
            self.submit_calls.append(job_arg.id)
            entered.set()
            await asyncio.sleep(3600)  # 模拟长时间图像生成。
            raise AssertionError("不该走到这里")

    image = Hanging()
    queue = await queue_factory(video=ScriptedProvider(), image=image)
    await queue.enqueue_submit(job)
    queue.start()

    await asyncio.wait_for(entered.wait(), timeout=20)
    assert (await repo.get(job.id, owner=None)).status == STATUS_SUBMITTING

    # 关停在两秒宽限期后打断提交，持久状态保留为 submitting。
    await queue.stop()
    assert (await repo.get(job.id, owner=None)).status == STATUS_SUBMITTING

    # 新进程处理重排任务，验证 submitting 状态守卫。
    queue.start()
    await wait_for_status(repo, job.id, STATUS_FAILED, timeout=60)

    stored = await repo.get(job.id, owner=None)
    assert stored.error_code == "SUBMIT_INTERRUPTED"
    assert image.submit_calls == [job.id], "重跑了，但绝不能再提交一次"


async def test_a_hard_killed_worker_is_found_by_heartbeat(
    engine: AsyncEngine, queue_factory: QueueFactory
) -> None:
    """直接认领任务并令心跳过期，模拟 worker 硬退出。

    不启动 worker，避免恢复任务在断言前被再次认领，专门验证失联检测 SQL。
    """

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await repo.create(make_job(image_request(), owner_user_id=owner))

    queue = await queue_factory(video=ScriptedProvider(), image=ScriptedProvider())
    await queue.enqueue_submit(job)

    worker_id = await queue.app.job_manager.register_worker()
    queued = await queue.app.job_manager.fetch_job(queues=[QUEUE_SUBMIT_IMAGE], worker_id=worker_id)
    assert queued is not None and queued.id is not None
    assert await _submit_task_statuses(engine) == ["doing"]

    assert await queue.heal_stalled() == 0

    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE procrastinate_workers SET last_heartbeat = NOW() - INTERVAL '1 hour'")
        )
    assert await queue.heal_stalled() == 1
    assert await _submit_task_statuses(engine) == ["todo"], "捡回去重排，等着守卫来收尾"

    assert await _submit_task_statuses(engine) == ["todo"], "捡回去重排，等着守卫来收尾"
