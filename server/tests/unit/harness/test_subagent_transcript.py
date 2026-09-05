"""子代理 transcript：父卡与任务在实时和历史两条路必须一致，子代理各自成一条流。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic_ai import Agent, CancellationToken
from pydantic_ai.exceptions import RunCancelled
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    PartDeltaEvent,
    PartEndEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel

from iclip.harness.agents import (
    DELEGATE_TOOL,
    AgentDefinition,
    AgentRegistry,
    SubAgentDefinition,
    build_agent_registry,
    delegate_display_table,
)
from iclip.harness.transcript.from_messages import (
    ChildRun,
    tasks_from_messages,
    turns_from_messages,
)
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.projector import TranscriptEventStream
from iclip.harness.transcript.store import TranscriptStore
from iclip.harness.transcript.subagents import SubAgentBridge, SubAgentMirror
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.platform.transcript.ops import (
    MAIN_AGENT_ID,
    AgentDescriptor,
    AgentRef,
    PromptContent,
    TextContent,
    TranscriptTask,
    TranscriptTurn,
)
from tests.helpers.transcript import (
    InMemoryConversationSnapshots,
    NoPromptRuns,
    replay,
    skeleton,
)

CONVERSATION = "conv-1"
PARENT = "producer"
RUN = "run-1"
PROMPT = "写三个镜头"
CONTENT: tuple[PromptContent, ...] = (TextContent(text=PROMPT),)
TASK = "写第 3 组的三个镜头"
CHILD = "child-run-1"
WRITER = "shot-writer"
COPY = "copy-writer"

DISPLAYS = ToolDisplayRegistry.merged(delegate_display_table())
"""用真实的 delegate 显示表，避免两条路同时缺 display 也能相等。"""


def _at(minute: int) -> datetime:
    return datetime(2026, 9, 4, 9, minute, tzinfo=UTC)


def _delegate_call(tool_call_id: str, agent_name: str, task: str) -> ToolCallPart:
    return ToolCallPart(
        tool_name=DELEGATE_TOOL,
        args={"agent_name": agent_name, "task": task},
        tool_call_id=tool_call_id,
    )


# --- 两条路的骨架对齐 -------------------------------------------------------


async def test_the_delegate_card_and_task_match_on_both_paths() -> None:
    call = _delegate_call("c1", WRITER, TASK)
    live = TranscriptStore()
    projector = TranscriptEventStream(
        turn_id="t1", turn_ordinal=1, content=CONTENT, display=DISPLAYS
    )

    async def stream() -> AsyncIterator[Any]:
        yield PartStartEvent(index=0, part=call)
        yield PartEndEvent(index=0, part=call)
        yield FunctionToolCallEvent(part=call)
        # 子运行开跑时父侧桥打的那一批，与投影器的批次共用同一条流。
        live.append(CONVERSATION, MAIN_AGENT_ID, projector.note_subagent("c1", CHILD, WRITER))
        yield FunctionToolResultEvent(
            part=ToolReturnPart(
                tool_name=DELEGATE_TOOL, content="三个镜头写好了", tool_call_id="c1"
            )
        )

    async for batch in projector.transform_stream(stream()):
        live.append(CONVERSATION, MAIN_AGENT_ID, batch)
    view = live.subscribe_view(CONVERSATION, MAIN_AGENT_ID)

    messages: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
        ModelResponse(parts=[call], run_id=RUN, timestamp=_at(1)),
        ModelRequest(
            parts=[
                ToolReturnPart(tool_name=DELEGATE_TOOL, content="三个镜头写好了", tool_call_id="c1")
            ],
            run_id=RUN,
            timestamp=_at(2),
        ),
    ]
    derived = turns_from_messages(
        messages,
        turn_states={RUN: "completed"},
        subagent_of_call={"c1": CHILD},
        display=DISPLAYS,
    )
    derived_tasks = tasks_from_messages(
        messages,
        subagent_of_call={"c1": CHILD},
        child_runs=(
            ChildRun(
                run_id=CHILD,
                agent_name=WRITER,
                started_at=_at(1),
                ended_at=_at(2),
                state="completed",
            ),
        ),
    )

    assert skeleton(view.live_turns) == skeleton(derived)
    assert _task_facts(view.snapshot.tasks) == _task_facts(derived_tasks)
    assert _task_facts(derived_tasks) == [
        (CHILD, "subagent", "completed", CHILD, WRITER, "三个镜头写好了")
    ]


async def test_the_child_stream_matches_the_derived_one() -> None:
    """子流与主流同构：任务文本是它这一轮的输入，步与块的编号规则不变。"""

    live = TranscriptStore()
    projector = TranscriptEventStream(
        agent_id=CHILD,
        turn_id="t1",
        turn_ordinal=1,
        run_id=CHILD,
        content=(TextContent(text=TASK),),
        display=DISPLAYS,
    )

    async def stream() -> AsyncIterator[Any]:
        yield PartStartEvent(index=0, part=TextPart(content=""))
        yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="镜头一"))
        yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="、镜头二"))
        yield PartEndEvent(index=0, part=TextPart(content="镜头一、镜头二"))

    async for batch in projector.transform_stream(stream()):
        live.append(CONVERSATION, CHILD, batch)

    derived = turns_from_messages(
        [
            ModelRequest(parts=[UserPromptPart(content=TASK)], run_id=CHILD, timestamp=_at(0)),
            ModelResponse(
                parts=[TextPart(content="镜头一、镜头二")], run_id=CHILD, timestamp=_at(1)
            ),
        ],
        turn_states={CHILD: "completed"},
        display=DISPLAYS,
    )

    assert skeleton(live.subscribe_view(CONVERSATION, CHILD).live_turns) == skeleton(derived)


async def test_a_failed_turn_fails_its_running_task() -> None:
    """父运行报错时，框架补的 failed 返回把任务一起收尾。"""

    task = await _task_after(RuntimeError("父运行炸了"))

    assert (task.state, task.state_reason) == ("failed", None)
    assert task.error is not None


async def test_a_stopped_turn_kills_its_running_task() -> None:
    """取消补的是 interrupted 返回，与历史从子运行事件推出的 killed 对上。"""

    assert (await _task_after(RunCancelled("用户停止"))).state == "killed"


async def test_a_task_whose_call_never_came_back_is_settled_by_the_turn() -> None:
    """正常收尾但那次调用一直没结果时，任务不能停在 running。"""

    task = await _task_after(None)

    # 不带 stateReason：历史只能从子运行事件推终态，两条路要对得上。
    assert (task.state, task.state_reason) == ("failed", None)
    assert task.ended_at is not None


async def _task_after(error: BaseException | None) -> TranscriptTask:
    """派出一个子代理后按 error 结束这一轮，返回它的任务。"""

    call = _delegate_call("c1", WRITER, TASK)
    live = TranscriptStore()
    projector = TranscriptEventStream(
        turn_id="t1", turn_ordinal=1, content=CONTENT, display=DISPLAYS
    )

    async def stream() -> AsyncIterator[Any]:
        yield PartStartEvent(index=0, part=call)
        yield PartEndEvent(index=0, part=call)
        yield FunctionToolCallEvent(part=call)
        live.append(CONVERSATION, MAIN_AGENT_ID, projector.note_subagent("c1", CHILD, WRITER))
        if error is not None:
            raise error

    async for batch in projector.transform_stream(stream()):
        live.append(CONVERSATION, MAIN_AGENT_ID, batch)
    return live.subscribe_view(CONVERSATION, MAIN_AGENT_ID).snapshot.tasks[0]


# --- 进程内端到端 -----------------------------------------------------------


async def test_one_delegation_lands_on_both_paths_and_in_the_ledger(tmp_path: Path) -> None:
    step_store = InMemoryConversationSnapshots()
    live = TranscriptStore()
    registry = _registry(
        tmp_path,
        step_store=step_store,
        live=live,
        parent=_delegates((WRITER, TASK)),
        children={WRITER: "镜头一、镜头二、镜头三"},
    )

    await _drive(registry.agents[PARENT], step_store=step_store, live=live)

    view = live.subscribe_view(CONVERSATION, MAIN_AGENT_ID)
    card = _delegate_cards(view.live_turns)[0]
    child_id = _child_id(card)
    assert card.agent_refs == (AgentRef(agent_id=child_id, role="child"),)
    assert _task_facts(view.snapshot.tasks) == [
        (child_id, "subagent", "completed", child_id, WRITER, "镜头一、镜头二、镜头三")
    ]

    # 子快照已落库，父侧桥当场交接，所以子流的实时轮次已释放，只能从补发日志重放。
    assert live.subscribe_view(CONVERSATION, child_id).live_turns == ()
    child_turns = replay(live, CONVERSATION, child_id)
    assert [(turn.turn_id, turn.state, turn.content) for turn in child_turns] == [
        ("t1", "completed", (TextContent(text=TASK),))
    ]

    effect = await step_store.get_tool_effect(run_id=RUN, tool_call_id=card.tool_call_id)
    assert effect is not None and effect.effect_summary == child_id
    record = await step_store.get_run(run_id=child_id)
    assert record is not None
    assert (record.parent_run_id, record.agent_name, record.metadata["agent_name"]) == (
        RUN,
        None,
        WRITER,
    )

    history = await TranscriptHistory(step_store, NoPromptRuns(), DISPLAYS, DELEGATE_TOOL).read(
        CONVERSATION
    )
    assert _delegate_cards(history.turns)[0].agent_refs == card.agent_refs
    assert _task_facts(history.tasks) == _task_facts(view.snapshot.tasks)
    assert history.agents == (
        AgentDescriptor(agent_id=MAIN_AGENT_ID, type="main"),
        AgentDescriptor(
            agent_id=child_id,
            type="sub",
            parent_agent_id=MAIN_AGENT_ID,
            label=WRITER,
            created_at=history.tasks[0].started_at,
        ),
    )


async def test_two_delegations_in_one_response_do_not_cross(tmp_path: Path) -> None:
    """并发派发验证 for_run 副本隔离：两条子流各自完整，账本各指各的。"""

    step_store = InMemoryConversationSnapshots()
    live = TranscriptStore()
    registry = _registry(
        tmp_path,
        step_store=step_store,
        live=live,
        parent=_delegates((WRITER, TASK), (COPY, "写一句文案")),
        children={WRITER: "镜头一、镜头二", COPY: "一句文案"},
    )

    await _drive(registry.agents[PARENT], step_store=step_store, live=live)

    view = live.subscribe_view(CONVERSATION, MAIN_AGENT_ID)
    cards = _delegate_cards(view.live_turns)
    assert len(cards) == 2
    by_agent = {_args(card)["agent_name"]: card for card in cards}
    assert set(by_agent) == {WRITER, COPY}
    assert _child_id(by_agent[WRITER]) != _child_id(by_agent[COPY])

    tasks = {task.task_id: task for task in view.snapshot.tasks}
    for agent_name, said in ((WRITER, "镜头一、镜头二"), (COPY, "一句文案")):
        card = by_agent[agent_name]
        child_id = _child_id(card)
        assert (tasks[child_id].description, tasks[child_id].result_summary) == (agent_name, said)
        child_turns = replay(live, CONVERSATION, child_id)
        assert [(turn.state, turn.content) for turn in child_turns] == [
            ("completed", (TextContent(text=_args(card)["task"]),))
        ]
        effect = await step_store.get_tool_effect(run_id=RUN, tool_call_id=card.tool_call_id)
        assert effect is not None and effect.effect_summary == child_id


async def test_stopping_the_parent_ends_the_child_stream_as_cancelled(tmp_path: Path) -> None:
    started = asyncio.Event()
    step_store = InMemoryConversationSnapshots()
    live = TranscriptStore()

    async def hangs(_messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
        started.set()
        await asyncio.sleep(30)
        yield "来不及了"

    registry = _registry(
        tmp_path,
        step_store=step_store,
        live=live,
        parent=_delegates((WRITER, TASK)),
        children={WRITER: hangs},
    )
    token = CancellationToken()

    async def stop() -> None:
        await started.wait()
        token.cancel()

    projector, _ = await asyncio.gather(
        _drive(registry.agents[PARENT], step_store=step_store, live=live, token=token), stop()
    )

    assert projector.cancelled is not None
    card = _delegate_cards(live.subscribe_view(CONVERSATION, MAIN_AGENT_ID).live_turns)[0]
    child_turns = replay(live, CONVERSATION, _child_id(card))
    assert [turn.state for turn in child_turns] == ["cancelled"]


# --- 装配与驱动 -------------------------------------------------------------

ChildModel = str | Callable[[list[ModelMessage], AgentInfo], AsyncIterator[str]]


def _delegates(
    *calls: tuple[str, str],
) -> Callable[[list[ModelMessage], AgentInfo], AsyncIterator[str | DeltaToolCalls]]:
    """父模型：第一次响应一口气派出这些子代理，之后收尾。"""

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
                )
                for index, (agent_name, task) in enumerate(calls)
            }
        else:
            yield "都写完了"

    return stream


def _says(text: str) -> Callable[[list[ModelMessage], AgentInfo], AsyncIterator[str]]:
    async def stream(_messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
        yield text

    return stream


def _spec(root: Path, name: str) -> Path:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "agent.yaml"
    path.write_text("model: test\n", encoding="utf-8")
    return path


def _registry(
    root: Path,
    *,
    step_store: InMemoryConversationSnapshots,
    live: TranscriptStore,
    parent: Callable[[list[ModelMessage], AgentInfo], AsyncIterator[str | DeltaToolCalls]],
    children: dict[str, ChildModel],
) -> AgentRegistry:
    """按真实装配路径建一个父代理加若干子代理，子代理各用自己的模型。"""

    models: dict[str, Any] = {PARENT: FunctionModel(stream_function=parent)}
    subagents: list[SubAgentDefinition] = []
    for name, model in children.items():
        models[name] = FunctionModel(
            stream_function=_says(model) if isinstance(model, str) else model
        )
        subagents.append(SubAgentDefinition(name=name, spec=_spec(root, name), model=name))
    return build_agent_registry(
        (
            AgentDefinition(
                agent_id=PARENT,
                spec=_spec(root, PARENT),
                model=PARENT,
                subagents=tuple(subagents),
            ),
        ),
        step_store=step_store,
        models=models,
        subagent_mirror=SubAgentMirror(live=live, display=DISPLAYS),
    )


async def _drive(
    agent: Agent[Any, Any],
    *,
    step_store: InMemoryConversationSnapshots,
    live: TranscriptStore,
    token: CancellationToken | None = None,
) -> TranscriptEventStream:
    """按运行驱动的接法跑一次父运行，返回它的投影器。"""

    projector = TranscriptEventStream(
        turn_id="t1", turn_ordinal=1, run_id=RUN, content=CONTENT, display=DISPLAYS
    )
    bridge = SubAgentBridge(
        store=step_store,
        live=live,
        conversation_id=CONVERSATION,
        projector=projector,
        delegate_tool=DELEGATE_TOOL,
    )
    async with agent.run_stream_events(
        PROMPT,
        conversation_id=CONVERSATION,
        run_id=RUN,
        cancellation_token=token,
        capabilities=[bridge],
    ) as events:
        async for batch in projector.transform_stream(events):
            live.append(CONVERSATION, MAIN_AGENT_ID, batch)
    return projector


def _delegate_cards(turns: Sequence[TranscriptTurn]) -> list[Any]:
    return [
        frame
        for turn in turns
        for step in turn.steps
        for frame in step.frames
        if frame.kind == "tool" and frame.name == DELEGATE_TOOL
    ]


def _args(card: Any) -> dict[str, Any]:
    """工具卡的入参：流式派发下模型给的是 JSON 文本，不是 dict。"""

    return card.input if isinstance(card.input, dict) else json.loads(card.input)


def _child_id(card: Any) -> str:
    assert card.agent_refs is not None and len(card.agent_refs) == 1
    return card.agent_refs[0].agent_id


def _task_facts(tasks: Sequence[TranscriptTask]) -> list[tuple[Any, ...]]:
    return [
        (
            task.task_id,
            task.kind,
            task.state,
            task.agent_id,
            task.description,
            task.result_summary,
        )
        for task in tasks
    ]
