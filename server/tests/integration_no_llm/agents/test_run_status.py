"""运行状态的判定：排队算在跑，等审批单列一档，没在跑就报上一轮结果。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, FunctionModel
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.harness.agents import DELEGATE_TOOL
from iclip.harness.jobs import JobQueue
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.service import TranscriptService
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.platform.transcript.ops import TextContent
from tests.helpers.runtime import (
    AGENT_ID,
    LOCKED_BY,
    OWNER,
    approval_runner,
    awaits,
    build_runner,
    drained,
    new_conversation_id,
    records_nothing,
    says,
    submit_text,
)


def explodes(reason: str) -> FunctionModel:
    """说半句就炸的模型。"""

    async def stream(_messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
        yield "刚开口"
        raise RuntimeError(reason)

    return FunctionModel(stream_function=stream)


def _service(
    store: TranscriptStore,
    step_store: PgStepStore,
    queue: JobQueue,
    runner: ConversationRunner,
) -> TranscriptService:
    return TranscriptService(
        store=store,
        history=TranscriptHistory(step_store, queue, ToolDisplayRegistry.EMPTY, DELEGATE_TOOL),
        queue=queue,
        runner=runner,
        context_limits={},
        record_materials=records_nothing,
    )


async def test_a_conversation_that_never_ran_is_idle(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("不会用到"), store=store)
    service = _service(store, step_store, queue, runner)

    status = await service.run_status(new_conversation_id())

    assert status.status == "idle"


async def test_a_finished_turn_reports_completed(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("写好了"), store=store)
    service = _service(store, step_store, queue, runner)
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "写三个镜头")
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert (await service.run_status(conversation_id)).status == "completed"


async def test_a_blown_up_turn_reports_failed(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine, explodes("上游炸了"), store=store, max_attempts=1
    )
    service = _service(store, step_store, queue, runner)
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "写三个镜头")
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert (await service.run_status(conversation_id)).status == "failed"


async def test_waiting_for_a_decision_is_its_own_status(engine: AsyncEngine) -> None:
    """轮询方看到 awaiting 才知道不给决定就不会往下走，不能混进 running。"""

    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store)
    service = _service(store, step_store, queue, runner)
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "把稿子写进文件")
    await awaits(queue, prompt_id)

    assert (await service.run_status(conversation_id)).status == "awaiting"
    await runner.shutdown()


async def test_a_queued_prompt_outranks_the_finished_turn(engine: AsyncEngine) -> None:
    """刚提交、还没被捡起来的那条也算在跑；照 activities 答会说成上一轮已完成。"""

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("不会用到"), store=store)
    service = _service(store, step_store, queue, runner)
    conversation_id = new_conversation_id()
    now = datetime.now(UTC)

    # 不交给 runner，两条消息就停在库里：第一条占着执行位置，第二条排队。
    first = await _plant(queue, conversation_id, "一", now=now)
    await _plant(queue, conversation_id, "二", now=now)
    await queue.finish(first, status="completed", now=now, locked_by=LOCKED_BY, attempt=0)

    assert (await queue.activities([conversation_id]))[conversation_id].last_turn_reason == (
        "completed"
    )
    assert (await service.run_status(conversation_id)).status == "running"


async def _plant(queue: JobQueue, conversation_id: str, text_: str, *, now: datetime) -> str:
    row, _ = await queue.submit(
        prompt_id=f"prm_{uuid.uuid4().hex[:8]}",
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        user_name="luke",
        content=(TextContent(text=text_),),
        now=now,
        locked_by=LOCKED_BY,
    )
    return row.prompt_id
