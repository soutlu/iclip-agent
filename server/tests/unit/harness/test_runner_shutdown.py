"""验证运行器关停在运行刚结束、还没从名单里摘掉的那一刻也能返回。"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.harness.job_status import JobStatus
from iclip.harness.jobs import JobQueue, JobRow
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.ops import TextContent

pytestmark = pytest.mark.unit


class _InstantQueue(JobQueue):
    """收尾要用的三个方法都不挂起，运行因此能在一次调度里从头跑到尾。"""

    def __init__(self, engine: AsyncEngine) -> None:
        super().__init__(engine)
        self.finished: list[str] = []

    async def finish(
        self, prompt_id: str, *, status: JobStatus, now: datetime, locked_by: str, attempt: int
    ) -> None:
        self.finished.append(prompt_id)

    async def get(self, prompt_id: str) -> JobRow | None:
        return None

    async def start_next(self, conversation_id: str, *, locked_by: str) -> JobRow | None:
        return None


def _running_row() -> JobRow:
    return JobRow(
        prompt_id="prm_shutdown",
        conversation_id="c-shutdown",
        agent_id="storyboard",
        owner_user_id=uuid.UUID("11111111-2222-3333-4444-555555555555"),
        user_name="luke",
        content=(TextContent(text="写三个镜头"),),
        status="running",
        run_id=None,
        created_at=datetime.now(UTC),
        finished_at=None,
        steered_at=None,
        locked_by="w-test",
        heartbeat_at=datetime.now(UTC),
        interrupt_reason=None,
        attempt=0,
        decisions={},
    )


async def _no_deps(_row: JobRow) -> None:
    return None


async def test_shutdown_returns_when_a_finished_run_is_still_on_the_books() -> None:
    # 不会真连：替身接住了收尾要用的方法，运行在碰数据库之前就失败了。
    engine = create_async_engine("postgresql+asyncpg://iclip:iclip@localhost:5432/nowhere")
    queue = _InstantQueue(engine)
    step_store = PgStepStore(engine)
    runner = ConversationRunner(
        # 没注册 agent：运行一开始就失败，收尾全落在不挂起的替身上。
        agents={},
        store=TranscriptStore(),
        queue=queue,
        snapshots=step_store,
        history=TranscriptHistory(step_store, queue),
        deps_for=_no_deps,
        context_limits={},
        heartbeat_seconds=10,
        lease_seconds=30,
        sweep_seconds=15,
        max_attempts=2,
        locked_by="w-test",
    )

    await runner.submit(_running_row())
    # 让出一轮：运行在这一轮里跑完，把自己摘出名单的回调排到下一轮。
    await asyncio.sleep(0)
    assert queue.finished == ["prm_shutdown"], "前提：运行已经跑完，只差回调摘名单"

    await runner.shutdown()
