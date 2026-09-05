"""transcript 场景测试：假模型跑真实运行，实时收到的页与冷启动重建的页必须一字不差。

一个场景一个用例。先比两条路（补发日志重放出来的页 vs 空实时店从持久化重建的页），
再补这个场景特有的几条事实。两个场景另存金样给前端测试消费。
"""

from __future__ import annotations

import asyncio
import difflib
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from pydantic_ai import Tool
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.messages import ModelMessage, ToolReturn
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaThinkingCalls,
    DeltaThinkingPart,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.harness.agents import (
    DELEGATE_TOOL,
    AgentDefinition,
    SubAgentDefinition,
    build_agent_registry,
    delegate_display_table,
    subagent_profiles,
)
from iclip.harness.jobs import JobQueue
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.transcript.from_messages import run_state_from_events, turns_from_messages
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.service import TranscriptService
from iclip.harness.transcript.store import TranscriptStore
from iclip.harness.transcript.subagents import SubAgentMirror
from iclip.platform.transcript.display import (
    FileIoDisplay,
    ToolDisplay,
    ToolDisplayEntry,
    ToolDisplayRegistry,
)
from iclip.platform.transcript.ops import MAIN_AGENT_ID, TextContent, ToolFrame, utf16_len
from iclip.platform.transcript.wire import TranscriptPage
from tests.helpers.runtime import (
    AGENT_ID,
    approval_runner,
    awaits,
    build_runner,
    calls_then_says,
    drained,
    first_run_messages,
    make_runner,
    new_conversation_id,
    plant_interrupted,
    records_nothing,
    says,
    submit_text,
)
from tests.helpers.transcript import (
    check_golden,
    cold_page,
    comparable,
    frames_of,
    live_page,
    normalize,
    ws_frames,
)


def _read_display(args: Any) -> ToolDisplay | None:
    path = args.get("path") if isinstance(args, dict) else None
    return FileIoDisplay(operation="read", path=path) if isinstance(path, str) and path else None


DISPLAYS = ToolDisplayRegistry.merged(
    {"Read": ToolDisplayEntry(draw=_read_display, view="file_content")}, delegate_display_table()
)
"""非空注册表，避免两条路同时缺 display 也能相等。"""


# --- 假模型 -----------------------------------------------------------------


def thinks_then_says(thought: str, *chunks: str) -> FunctionModel:
    """一次响应：先一段思考，再按块吐正文。"""

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaThinkingCalls]:
        yield {0: DeltaThinkingPart(content=thought)}
        for chunk in chunks:
            yield chunk

    return FunctionModel(stream_function=stream)


def reads_then_says(path: str, reply: str) -> FunctionModel:
    """第一步读文件，第二步说一句。toolCallId 写死，金样才稳定。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            yield {
                0: DeltaToolCall(
                    name="Read", json_args=f'{{"path": "{path}"}}', tool_call_id="call_read"
                )
            }
        else:
            yield reply

    return FunctionModel(stream_function=stream)


def read_tool() -> Tool[Any]:
    def read(path: str) -> ToolReturn:
        return ToolReturn(
            return_value="# 简报\n运动鞋，三组镜头。", metadata={"path": path, "lines": 2}
        )

    return Tool(read, name="Read")


# --- 两条路 -----------------------------------------------------------------


async def both_pages(
    store: TranscriptStore,
    step_store: PgStepStore,
    queue: JobQueue,
    runner: ConversationRunner,
    conversation_id: str,
    agent_id: str = MAIN_AGENT_ID,
) -> tuple[TranscriptPage, TranscriptPage]:
    """实时重放的页与冷启动重建的页，比对后一并返回。"""

    live = await live_page(
        store,
        conversation_id,
        agent_id,
        queue=queue,
        runner=runner,
        display=DISPLAYS,
        runtime_agent_id=AGENT_ID,
    )
    cold = await cold_page(
        step_store,
        conversation_id,
        agent_id,
        queue=queue,
        runner=runner,
        display=DISPLAYS,
        runtime_agent_id=AGENT_ID,
        delegate_tool=DELEGATE_TOOL,
    )
    assert_same_page(live, cold)
    return live, cold


def assert_same_page(live: TranscriptPage, cold: TranscriptPage) -> None:
    """两页不等时给出逐行 diff，比 pytest 对大字典的摘要好读。"""

    a = json.dumps(comparable(live), ensure_ascii=False, indent=1).splitlines()
    b = json.dumps(comparable(cold), ensure_ascii=False, indent=1).splitlines()
    if a != b:
        diff = "\n".join(difflib.unified_diff(a, b, "实时重放", "冷启动重建", lineterm="", n=2))
        raise AssertionError(f"两条路的页不一样：\n{diff}")


def _appends_to(frames: list[Any], frame_id: str) -> list[tuple[int, str]]:
    return [
        (op["offset"], op["text"])
        for frame in frames
        if frame["type"] == "transcript.ops"
        for op in frame["payload"]["ops"]
        if op["op"] == "append" and op["target"]["frameId"] == frame_id
    ]


def _args(card: ToolFrame) -> dict[str, Any]:
    """工具卡的参数：假模型给的是 JSON 字符串，真厂商多是对象，两种都认。"""

    return json.loads(card.input) if isinstance(card.input, str) else dict(card.input or {})


# --- 场景 -------------------------------------------------------------------


async def test_thinking_then_text_with_emoji(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        thinks_then_says("先想想怎么拆", "好👌，", "分三组🎬拍。"),
        store=store,
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "给这条视频做分镜")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    frames = frames_of(live, "t1", "t1.1")
    assert [(frame.frame_id, frame.kind) for frame in frames] == [
        ("t1.1.f1", "thinking"),
        ("t1.1.f2", "text"),
    ]
    assert frames[1].text == "好👌，分三组🎬拍。"
    # 逐字追加的 offset 按 UTF-16 累加，emoji 占两个单位。
    assert _appends_to(ws_frames(store, conversation_id), "t1.1.f2") == [
        (0, "好👌，"),
        (utf16_len("好👌，"), "分三组🎬拍。"),
    ]


async def test_a_tool_call_then_a_reply_make_two_steps(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        reads_then_says("brief.md", "读完了，开拆。"),
        store=store,
        tools=[read_tool()],
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "先看简报再拆")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, cold = await both_pages(store, step_store, queue, runner, conversation_id)

    assert [step.step_id for step in live.items[0].steps] == ["t1.1", "t1.2"]
    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame)
    assert (card.state, card.view, card.display) == (
        "done",
        "file_content",
        FileIoDisplay(operation="read", path="brief.md"),
    )
    assert card.metadata == {"path": "brief.md", "lines": 2}
    check_golden(
        "tool-turn", {"ws": normalize(ws_frames(store, conversation_id)), "rest": comparable(cold)}
    )


async def test_a_tool_that_rejects_its_input_settles_the_card_as_an_error(
    engine: AsyncEngine,
) -> None:
    def boom() -> str:
        raise ModelRetry("简报读不到，换个路径")

    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        calls_then_says("Boom", "那我先不读了"),
        store=store,
        tools=[Tool(boom, name="Boom")],
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "读一下简报")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame)
    assert card.state == "error"
    assert card.error is not None and "简报读不到" in card.error
    assert live.items[0].state == "completed"


async def test_a_steer_lands_on_the_step_that_was_running(engine: AsyncEngine) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        waits_then_says(entered, gate, "第一句", "补充收到了"),
        store=store,
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()
    await runner.steer(conversation_id, (second,))
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 插话挂在当时正在跑的那一步末尾，与正文共用块序号；模型的回应开新的一步。
    assert [
        (frame.frame_id, getattr(frame, "role", None), getattr(frame, "prompt_ids", None))
        for frame in frames_of(live, "t1", "t1.1")
    ] == [
        ("t1.1.f1", "assistant", None),
        ("t1.1.f2", "user", (second,)),
    ]
    assert [step.step_id for step in live.items[0].steps] == ["t1.1", "t1.2"]


async def test_stopping_the_run_ends_the_turn_as_cancelled(engine: AsyncEngine) -> None:
    """第二步说到一半被停。官方只在节点边界存快照，第一步就停的轮历史里没有，那是持久化的边界。"""

    entered = asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        reads_then_hangs(entered),
        store=store,
        tools=[read_tool()],
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "看完简报慢慢想")
    await entered.wait()
    await runner.abort(conversation_id, prompt_id)
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    assert [turn.state for turn in live.items] == ["cancelled"]
    assert [step.step_id for step in live.items[0].steps] == ["t1.1", "t1.2"]
    assert frames_of(live, "t1", "t1.2")[0].text == "想到一半"
    assert live.meta.activity == "idle"


async def test_a_model_failure_ends_the_turn_as_failed(engine: AsyncEngine) -> None:
    """第二步说到一半上游炸了；第一步就炸的轮同上，历史里没有。"""

    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        reads_then_explodes("上游炸了"),
        store=store,
        tools=[read_tool()],
        display=DISPLAYS,
        context_limits={},
        max_attempts=1,
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "看完简报来一段")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    turn = live.items[0]
    assert turn.state == "failed"
    assert turn.error is not None and "上游炸了" in turn.error
    assert [step.step_id for step in turn.steps] == ["t1.1", "t1.2"]
    assert frames_of(live, "t1", "t1.2")[0].text == "刚开口"


async def test_an_approved_tool_resumes_the_same_turn(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store)
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    await awaits(queue, prompt_id)
    await runner.approve(conversation_id, "apr_call_1", approved=True)
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 审批前后是两个 run，合成一轮、步号连续；交互是不分页的全局实体。
    assert [step.step_id for step in live.items[0].steps] == ["t1.1", "t1.2"]
    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame)
    assert (card.state, card.approval_id) == ("done", "apr_call_1")
    assert [(item.interaction_id, item.state) for item in live.interactions] == [
        ("apr_call_1", "approved")
    ]
    assert live.pending_interactions == ()


async def test_a_rejected_tool_settles_as_an_error_and_the_model_moves_on(
    engine: AsyncEngine,
) -> None:
    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store, reply="那我不动它")
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    await awaits(queue, prompt_id)
    await runner.approve(conversation_id, "apr_call_1", approved=False)
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame)
    assert card.state == "error"
    assert [item.state for item in live.interactions] == ["rejected"]
    assert frames_of(live, "t1", "t1.2")[0].text == "那我不动它"


async def test_a_crashed_run_resumes_into_the_same_turn(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine, says("接着写完了"), store=store, display=DISPLAYS, context_limits={}
    )
    conversation_id = new_conversation_id()
    dead_run = f"{AGENT_ID}-dead"
    await plant_interrupted(
        engine,
        step_store,
        queue,
        conversation_id,
        run_id=dead_run,
        messages=first_run_messages(dead_run),
    )

    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 续跑是新 run，但落回原轮：旧步标中断、新步接着编号，用户消息不重复。
    assert [(turn.turn_id, turn.state) for turn in live.items] == [("t1", "completed")]
    assert [step.state for step in live.items[0].steps] == ["interrupted", "completed"]
    assert [frame.frame_id for frame in frames_of(live, "t1", "t1.1")] == ["t1.1.call_1"]
    assert frames_of(live, "t1", "t1.2")[0].text == "接着写完了"


async def test_regenerating_the_last_turn_replaces_it(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine, says("第一次", "第二次"), store=store, display=DISPLAYS, context_limits={}
    )
    conversation_id = new_conversation_id()
    service = TranscriptService(
        store=store,
        history=TranscriptHistory(step_store, queue, DISPLAYS, DELEGATE_TOOL),
        queue=queue,
        runner=runner,
        context_limits={},
        record_materials=records_nothing,
    )

    first = await submit_text(runner, queue, conversation_id, "写一句")
    await drained(queue, conversation_id)
    again = await service.regenerate(conversation_id=conversation_id, turn_id="t1")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 重跑前先删旧轮，新的一轮沿用 t1，但认领的是新那条消息。
    removals = [
        op
        for frame in ws_frames(store, conversation_id)
        if frame["type"] == "transcript.ops"
        for op in frame["payload"]["ops"]
        if op["op"] == "items.remove"
    ]
    assert [list(op["ids"]) for op in removals] == [["t1"]]
    assert [(turn.turn_id, turn.trigger_prompt_id) for turn in live.items] == [
        ("t1", again.prompt_id)
    ]
    assert again.prompt_id != first
    assert frames_of(live, "t1", "t1.1")[0].text == "第二次"


# --- 子代理 -------------------------------------------------------------------

WRITER = "shot-writer"
COPY = "copy-writer"
TASK = "写第 3 组的三个镜头"


async def test_a_delegation_becomes_its_own_stream(engine: AsyncEngine, tmp_path: Path) -> None:
    store = TranscriptStore()
    writer = says("S3-1 特写；S3-2 中景；S3-3 全景")
    runner, step_store, queue = subagent_runner(
        engine, tmp_path, store=store, parent=delegates((WRITER, TASK)), children={WRITER: writer}
    )
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "给这条视频做分镜")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, cold = await both_pages(store, step_store, queue, runner, conversation_id)

    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame)
    assert card.agent_refs is not None and len(card.agent_refs) == 1
    child_id = card.agent_refs[0].agent_id
    assert [
        (task.task_id, task.state, task.description, task.result_summary, task.model)
        for task in live.tasks
    ] == [(child_id, "completed", WRITER, "S3-1 特写；S3-2 中景；S3-3 全景", writer.model_name)]
    # 子代理的描述随任务结束：disposedAt 就是任务的 endedAt。
    assert [(agent.agent_id, agent.type, agent.disposed_at) for agent in live.agents] == [
        (MAIN_AGENT_ID, "main", None),
        (child_id, "sub", live.tasks[0].ended_at),
    ]
    assert live.tasks[0].ended_at is not None
    await assert_child_stream(
        store, step_store, queue, runner, conversation_id, child_id, task=TASK
    )

    row = await queue.get(prompt_id)
    assert row is not None and row.run_id is not None
    effect = await step_store.get_tool_effect(run_id=row.run_id, tool_call_id=card.tool_call_id)
    assert effect is not None and effect.effect_summary == child_id
    record = await step_store.get_run(run_id=child_id)
    assert record is not None
    assert (record.parent_run_id, record.metadata["agent_name"]) == (row.run_id, WRITER)
    check_golden("delegate-turn", {"rest": comparable(cold)})


async def test_two_delegations_in_one_response_do_not_cross(
    engine: AsyncEngine, tmp_path: Path
) -> None:
    store = TranscriptStore()
    runner, step_store, queue = subagent_runner(
        engine,
        tmp_path,
        store=store,
        parent=delegates((WRITER, TASK), (COPY, "写一句文案")),
        children={WRITER: says("镜头一、镜头二"), COPY: says("一句文案")},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "分镜和文案一起来")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    cards = [frame for frame in frames_of(live, "t1", "t1.1") if isinstance(frame, ToolFrame)]
    by_name = {_args(card)["agent_name"]: card for card in cards}
    assert set(by_name) == {WRITER, COPY}
    tasks = {task.task_id: task for task in live.tasks}
    for name, said_text, task_text in (
        (WRITER, "镜头一、镜头二", TASK),
        (COPY, "一句文案", "写一句文案"),
    ):
        card = by_name[name]
        assert card.agent_refs is not None
        child_id = card.agent_refs[0].agent_id
        assert (tasks[child_id].description, tasks[child_id].result_summary) == (name, said_text)
        await assert_child_stream(
            store, step_store, queue, runner, conversation_id, child_id, task=task_text
        )
    assert len({card.agent_refs[0].agent_id for card in cards if card.agent_refs}) == 2


async def test_stopping_the_parent_kills_the_child(engine: AsyncEngine, tmp_path: Path) -> None:
    entered = asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = subagent_runner(
        engine,
        tmp_path,
        store=store,
        parent=delegates((WRITER, TASK)),
        children={WRITER: hangs(entered)},
    )
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "给这条视频做分镜")
    await entered.wait()
    await runner.abort(conversation_id, prompt_id)
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    assert [turn.state for turn in live.items] == ["cancelled"]
    assert [task.state for task in live.tasks] == ["killed"]
    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame) and card.agent_refs is not None
    # 子运行在它的第一个响应里就被停了，快照里没有它，冷侧读不到；这条边界与主 agent 相同。
    await assert_child_stream(
        store,
        step_store,
        queue,
        runner,
        conversation_id,
        card.agent_refs[0].agent_id,
        task=TASK,
        state="cancelled",
        cold=False,
    )


def _spec(root: Path, name: str) -> Path:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "agent.yaml"
    path.write_text("model: test\n", encoding="utf-8")
    return path


def subagent_runner(
    engine: AsyncEngine,
    root: Path,
    *,
    store: TranscriptStore,
    parent: FunctionModel,
    children: dict[str, FunctionModel],
) -> tuple[ConversationRunner, PgStepStore, JobQueue]:
    """按真实装配路径建一个带子代理的主 agent，再按生产接法装 runner。"""

    step_store = PgStepStore(engine)
    models: dict[str, Any] = {AGENT_ID: parent, **children}
    definitions = (
        AgentDefinition(
            agent_id=AGENT_ID,
            spec=_spec(root, AGENT_ID),
            model=AGENT_ID,
            subagents=tuple(
                SubAgentDefinition(name=name, spec=_spec(root, name), model=name)
                for name in children
            ),
        ),
    )
    registry = build_agent_registry(
        definitions,
        step_store=step_store,
        models=models,
        subagent_mirror=SubAgentMirror(
            live=store, display=DISPLAYS, profiles=subagent_profiles(definitions, models)
        ),
    )
    return make_runner(
        engine,
        agents=registry.agents,
        step_store=step_store,
        store=store,
        display=DISPLAYS,
        context_limits={},
    )


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


async def assert_child_stream(
    store: TranscriptStore,
    step_store: PgStepStore,
    queue: JobQueue,
    runner: ConversationRunner,
    conversation_id: str,
    child_id: str,
    *,
    task: str,
    state: str = "completed",
    cold: bool = True,
) -> None:
    """子代理那条流：实时重放的轮与从它自己的快照重建的轮一致，且只有以任务文本开头的 t1。

    协议还没有读子代理流的入口（PR2），冷侧先直接从快照重建；cold=False 只看实时那份。
    """

    live = await live_page(
        store,
        conversation_id,
        child_id,
        queue=queue,
        runner=runner,
        display=DISPLAYS,
        runtime_agent_id=AGENT_ID,
    )
    assert [(turn.turn_id, turn.state, turn.content) for turn in live.items] == [
        ("t1", state, (TextContent(text=task),))
    ]
    if not cold:
        return
    snapshot = await step_store.latest_snapshot(run_id=child_id, include_interrupted=True)
    assert snapshot is not None
    events = await step_store.list_events(run_id=child_id)
    derived = turns_from_messages(
        snapshot.messages,
        turn_states={child_id: run_state_from_events(events)},
        display=DISPLAYS,
    )
    assert normalize(live.items) == normalize(derived)


# --- 更多假模型 -----------------------------------------------------------------


def reads_then_hangs(entered: asyncio.Event) -> FunctionModel:
    """第一步读文件，第二步说半句就卡住。先过一个节点边界，这半句才会落进中断快照。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            yield {
                0: DeltaToolCall(
                    name="Read", json_args='{"path": "brief.md"}', tool_call_id="call_read"
                )
            }
            return
        yield "想到一半"
        entered.set()
        await asyncio.sleep(30)
        yield "来不及了"

    return FunctionModel(stream_function=stream)


def reads_then_explodes(reason: str) -> FunctionModel:
    """第一步读文件，第二步说半句就炸。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            yield {
                0: DeltaToolCall(
                    name="Read", json_args='{"path": "brief.md"}', tool_call_id="call_read"
                )
            }
            return
        yield "刚开口"
        raise RuntimeError(reason)

    return FunctionModel(stream_function=stream)


def waits_then_says(
    entered: asyncio.Event, gate: asyncio.Event, first: str, second: str
) -> FunctionModel:
    """首个请求卡在门上等插话进来，之后各答一句。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            entered.set()
            await gate.wait()
            yield first
        else:
            yield second

    return FunctionModel(stream_function=stream)


def hangs(entered: asyncio.Event) -> FunctionModel:
    """子代理用：说了半句就卡住，等父运行来停它。"""

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        yield "想到一半"
        entered.set()
        await asyncio.sleep(30)
        yield "来不及了"

    return FunctionModel(stream_function=stream)
