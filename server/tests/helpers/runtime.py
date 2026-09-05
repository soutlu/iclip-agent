"""用真 Postgres 与假模型把 ConversationRunner 跑起来的公共夹具。

runner 的队列、续跑测试与 transcript 场景测试共用这一份，改装配只改这里。
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from pydantic_ai import Agent, Tool
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel
from pydantic_ai.tools import DeferredToolRequests
from pydantic_ai_harness.step_persistence import (
    ContinuableSnapshot,
    RunRecord,
    StepEvent,
    StepPersistence,
)
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.harness.agents import DELEGATE_TOOL
from iclip.harness.jobs import JobQueue, JobRow
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.platform.transcript.ops import (
    MAIN_AGENT_ID,
    PromptContent,
    TextContent,
    ToolFrame,
    TranscriptTurn,
)

AGENT_ID = "storyboard"
MAX_CONTEXT_TOKENS = 4096
OWNER = uuid.UUID("11111111-2222-3333-4444-555555555555")
LOCKED_BY = "w-test"
"""固定当前 runner 的租约属主，便于直接模拟租约转移。"""
DEAD = "w-dead"
"""模拟已退出进程的租约属主，不再更新心跳。"""


def new_conversation_id() -> str:
    return f"c-{uuid.uuid4().hex[:8]}"


async def records_nothing(
    owner: uuid.UUID, conversation_id: str, content: Sequence[PromptContent]
) -> None:
    """只读场景使用空素材登记实现。"""

    _ = (owner, conversation_id, content)


# --- 假模型 -----------------------------------------------------------------


def says(*replies: str) -> FunctionModel:
    """按预设顺序返回模型回复。"""

    said = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal said
        yield replies[min(said, len(replies) - 1)]
        said += 1

    return FunctionModel(stream_function=stream)


def delegates(*calls: tuple[str, str]) -> FunctionModel:
    """父模型：第一次响应一口气派出这些子代理，之后收尾。toolCallId 写死。"""

    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        if len(messages) == 1:
            yield {
                index: DeltaToolCall(
                    name=DELEGATE_TOOL,
                    json_args=json.dumps(
                        {"agent_name": agent_name, "task": task}, ensure_ascii=False
                    ),
                    tool_call_id=f"call_d{index + 1}",
                )
                for index, (agent_name, task) in enumerate(calls)
            }
        else:
            yield "都写完了"

    return FunctionModel(stream_function=stream)


def waits(entered: asyncio.Event, gate: asyncio.Event) -> FunctionModel:
    """通过事件阻塞响应，确定性地保持运行中状态。"""

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        entered.set()
        await gate.wait()
        yield "跑完了"

    return FunctionModel(stream_function=stream)


def calls_tool(name: str) -> FunctionModel:
    """首个请求触发工具调用，后续请求不应发生。"""

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        yield {0: DeltaToolCall(name=name, json_args="{}", tool_call_id="call_boom")}

    return FunctionModel(stream_function=stream)


def calls_then_says(name: str, reply: str, *, calls: int = 1) -> FunctionModel:
    """首次调用待审批工具，后续响应覆盖审批决定后的续跑。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            yield {
                index: DeltaToolCall(name=name, json_args="{}", tool_call_id=f"call_{index + 1}")
                for index in range(calls)
            }
        else:
            yield reply

    return FunctionModel(stream_function=stream)


def wrote() -> str:
    """一件要审批才能动的工具。审批本身不经过它，所以内容无所谓。"""

    return "写好了"


def texts(messages: list[ModelMessage]) -> list[str]:
    return [
        part.content
        for message in messages
        for part in getattr(message, "parts", ())
        if isinstance(part, UserPromptPart) and isinstance(part.content, str)
    ]


# --- 装配 -------------------------------------------------------------------


def make_runner(
    engine: AsyncEngine,
    *,
    agents: Mapping[str, Agent[Any, Any]],
    step_store: PgStepStore,
    store: TranscriptStore,
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
    locked_by: str = LOCKED_BY,
    max_attempts: int = 2,
    context_limits: Mapping[str, int] | None = None,
) -> tuple[ConversationRunner, PgStepStore, JobQueue]:
    """按生产接法装 runner；context_limits 不给就按 AGENT_ID 开一个窗口。"""

    queue = JobQueue(engine)

    async def deps_for(_row: Any) -> object:
        return None

    runner = ConversationRunner(
        agents=dict(agents),
        store=store,
        queue=queue,
        snapshots=step_store,
        history=TranscriptHistory(step_store, queue, display, DELEGATE_TOOL),
        deps_for=deps_for,
        context_limits=(
            {AGENT_ID: MAX_CONTEXT_TOKENS} if context_limits is None else dict(context_limits)
        ),
        heartbeat_seconds=10,
        lease_seconds=30,
        sweep_seconds=15,
        max_attempts=max_attempts,
        locked_by=locked_by,
        display=display,
    )
    return runner, step_store, queue


def build_runner(
    engine: AsyncEngine,
    model: FunctionModel,
    *,
    store: TranscriptStore,
    tools: Sequence[Any] = (),
    locked_by: str = LOCKED_BY,
    max_attempts: int = 2,
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
    context_limits: Mapping[str, int] | None = None,
) -> tuple[ConversationRunner, PgStepStore, JobQueue]:
    """一个主 agent、一个假模型的 runner。"""

    step_store = PgStepStore(engine)
    agent = Agent(
        model,
        name=AGENT_ID,
        tools=list(tools),
        # DeferredToolRequests 必须纳入输出类型，以允许待审批工具结束本次 run。
        output_type=[str, DeferredToolRequests],
        # 不设置顶层 agent_name，保持调用方传入的 run_id。
        capabilities=[StepPersistence(store=step_store)],
    )
    return make_runner(
        engine,
        agents={AGENT_ID: agent},
        step_store=step_store,
        store=store,
        display=display,
        locked_by=locked_by,
        max_attempts=max_attempts,
        context_limits=context_limits,
    )


def approval_runner(
    engine: AsyncEngine, store: TranscriptStore, *, reply: str = "改完了", calls: int = 1
) -> tuple[ConversationRunner, PgStepStore, JobQueue]:
    """装配待审批工具；首个请求调用工具，后续请求返回文本。"""

    return build_runner(
        engine,
        calls_then_says("write_file", reply, calls=calls),
        store=store,
        tools=[Tool(wrote, name="write_file", requires_approval=True)],
    )


# --- 驱动 -------------------------------------------------------------------


async def submit_text(
    runner: ConversationRunner,
    queue: JobQueue,
    conversation_id: str,
    text_: str,
    *,
    content: tuple[PromptContent, ...] | None = None,
) -> str:
    """提交一条消息并交给 runner；content 给了就用它，不给就是一段文字。"""

    prompt_id = f"prm_{uuid.uuid4().hex[:8]}"
    row = await queue.submit(
        prompt_id=prompt_id,
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text=text_),) if content is None else content,
        now=datetime.now(UTC),
        locked_by=runner.locked_by,
    )
    await runner.submit(row)
    return prompt_id


async def expire_lease(engine: AsyncEngine, conversation_id: str, *, attempt: int = 0) -> None:
    """将心跳设为一小时前以模拟租约过期；attempt 参数控制是否允许再次认领。"""

    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE agent_runtime.agent_jobs "
                "SET heartbeat_at = now() - INTERVAL '1 hour', attempt = :attempt "
                "WHERE conversation_id = :conversation_id AND status = 'running'"
            ),
            {"conversation_id": conversation_id, "attempt": attempt},
        )


def first_run_messages(run_id: str) -> list[ModelMessage]:
    """模拟已完成工具周期后的中断历史；固定过去时间确保续跑消息排序在后。"""

    started = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
    return [
        ModelRequest(
            parts=[UserPromptPart(content="把这三个镜头出图")], run_id=run_id, timestamp=started
        ),
        ModelResponse(
            parts=[ToolCallPart(tool_name="draft", args="{}", tool_call_id="call_1")],
            run_id=run_id,
            timestamp=started,
        ),
        ModelRequest(
            parts=[ToolReturnPart(tool_name="draft", content="出好了", tool_call_id="call_1")],
            run_id=run_id,
            timestamp=started,
        ),
    ]


async def plant_interrupted(
    engine: AsyncEngine,
    step_store: PgStepStore,
    queue: JobQueue,
    conversation_id: str,
    *,
    run_id: str,
    messages: list[ModelMessage] | None = None,
    attempt: int = 0,
) -> str:
    """插入 running、心跳过期的任务及 run 映射。

    提供 messages 时另存快照和 run_started，不写终止事件；否则模拟首个快照前中断。
    """

    prompt_id = f"prm_{uuid.uuid4().hex[:8]}"
    await queue.submit(
        prompt_id=prompt_id,
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text="把这三个镜头出图"),),
        now=datetime.now(UTC),
        locked_by=DEAD,
    )
    await queue.attach_run(prompt_id, run_id, locked_by=DEAD, attempt=0)
    if messages is not None:
        await step_store.register_run(RunRecord(run_id=run_id, conversation_id=conversation_id))
        await step_store.append_event(
            StepEvent(
                run_id=run_id, kind="run_started", step_index=0, conversation_id=conversation_id
            )
        )
        await step_store.save_snapshot(
            ContinuableSnapshot(
                run_id=run_id, step_index=1, messages=messages, conversation_id=conversation_id
            )
        )
    await expire_lease(engine, conversation_id, attempt=attempt)
    return prompt_id


async def drained(queue: JobQueue, conversation_id: str, *, tries: int = 200) -> None:
    """等待运行中和排队任务清空；待审批任务需使用 awaits 等待。"""

    for _ in range(tries):
        view = await queue.view(conversation_id)
        if view.active is None and not view.queued:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("队列没排空")


async def awaits(queue: JobQueue, prompt_id: str, *, tries: int = 200) -> JobRow:
    for _ in range(tries):
        row = await queue.get(prompt_id)
        if row is not None and row.status == "awaiting":
            return row
        await asyncio.sleep(0.02)
    raise AssertionError("这条 prompt 没停在审批上")


# --- 读 ---------------------------------------------------------------------


def prompt_text(turn: TranscriptTurn) -> str:
    return "".join(part.text for part in turn.content if part.type == "text")


def replay_journal(
    store: TranscriptStore, conversation_id: str, agent_id: str = MAIN_AGENT_ID
) -> TranscriptStore:
    """把客户端实际收到的批次重放进一个新 store；轮持久化后原 store 的 live_turns 会清空。"""

    replayed = TranscriptStore()
    for batch in store.subscribe_view(conversation_id, agent_id, since=0).batches:
        replayed.append(conversation_id, agent_id, batch.ops)
    return replayed


def replay(
    store: TranscriptStore, conversation_id: str, agent_id: str = MAIN_AGENT_ID
) -> tuple[TranscriptTurn, ...]:
    return (
        replay_journal(store, conversation_id, agent_id)
        .subscribe_view(conversation_id, agent_id)
        .live_turns
    )


def tool_cards(turns: Sequence[TranscriptTurn]) -> list[ToolFrame]:
    return [
        frame
        for turn in turns
        for step in turn.steps
        for frame in step.frames
        if isinstance(frame, ToolFrame)
    ]


__all__ = [
    "AGENT_ID",
    "DEAD",
    "LOCKED_BY",
    "MAX_CONTEXT_TOKENS",
    "OWNER",
    "approval_runner",
    "awaits",
    "build_runner",
    "calls_then_says",
    "calls_tool",
    "drained",
    "expire_lease",
    "first_run_messages",
    "make_runner",
    "new_conversation_id",
    "plant_interrupted",
    "prompt_text",
    "records_nothing",
    "replay",
    "replay_journal",
    "says",
    "submit_text",
    "texts",
    "tool_cards",
    "waits",
    "wrote",
]
