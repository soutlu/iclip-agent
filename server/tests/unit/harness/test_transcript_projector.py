"""投影器自己的规则：端到端跑不出来、只能用手工事件钉住的那几条。

真实运行能产出的形状都在 integration_no_llm/agents/test_transcript_scenarios.py 里比两条路。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

from pydantic_ai.exceptions import RunCancelled
from pydantic_ai.messages import (
    CompactionPart,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
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

from iclip.harness.agents import DELEGATE_TOOL, delegate_display_table
from iclip.harness.transcript.from_messages import turns_from_messages
from iclip.harness.transcript.projector import TranscriptEventStream
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.display import (
    FileIoDisplay,
    ToolDisplay,
    ToolDisplayEntry,
    ToolDisplayRegistry,
)
from iclip.platform.transcript.ops import (
    MAIN_AGENT_ID,
    AgentRef,
    FrameUpsertOp,
    PromptContent,
    TextContent,
    ToolFrame,
    TranscriptStep,
    TranscriptTask,
    TranscriptTurn,
    TurnOrigin,
)
from tests.helpers.transcript import normalize

CONVERSATION = "conv-1"
RUN = "run-a"
PROMPT = "帮我把 README 翻译成英文"
CONTENT: tuple[PromptContent, ...] = (TextContent(text=PROMPT),)
WRITER = "shot-writer"
TASK = "写第 3 组的三个镜头"
CHILD = "child-run-1"


def _read_display(args: Any) -> ToolDisplay | None:
    path = args.get("path") if isinstance(args, dict) else None
    return FileIoDisplay(operation="read", path=path) if isinstance(path, str) and path else None


DISPLAYS = ToolDisplayRegistry.merged(
    {"Read": ToolDisplayEntry(draw=_read_display, view="file_content")}, delegate_display_table()
)
"""非空注册表，避免两条路同时缺 display 也能相等。"""


def _at(minute: int) -> datetime:
    return datetime(2026, 8, 30, 9, minute, tzinfo=UTC)


def _projector() -> TranscriptEventStream:
    return TranscriptEventStream(turn_id="t1", turn_ordinal=1, content=CONTENT, display=DISPLAYS)


async def _live(
    projector: TranscriptEventStream, events: AsyncIterator[Any]
) -> tuple[TranscriptTurn, ...]:
    store = TranscriptStore()
    async for batch in projector.transform_stream(events):
        store.append(CONVERSATION, MAIN_AGENT_ID, batch)
    return store.subscribe_view(CONVERSATION, MAIN_AGENT_ID).live_turns


def _derived(*messages: Any) -> tuple[TranscriptTurn, ...]:
    return turns_from_messages(list(messages), turn_states={RUN: "completed"}, display=DISPLAYS)


def _shape(turns: tuple[TranscriptTurn, ...]) -> Any:
    """手工事件里没有 AgentRunResultEvent，实时侧补不上用量；步的 startedAt 实时侧本来就不写。"""

    def strip(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: strip(item)
                for key, item in value.items()
                if key != "usage" and not (key == "startedAt" and value.get("kind") == "step")
            }
        if isinstance(value, list):
            return [strip(item) for item in value]
        return value

    return strip(normalize(turns))


# --- 只能用手工事件造出来的形状 -------------------------------------------------


async def test_two_adjacent_text_parts_stay_two_frames_on_both_paths() -> None:
    """模型一次响应里连发两段正文是两个块，不并成一段；假模型造不出这个形状。"""

    async def stream() -> AsyncIterator[Any]:
        yield PartStartEvent(index=0, part=TextPart(content=""))
        yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="第一段"))
        yield PartEndEvent(index=0, part=TextPart(content="第一段"))
        yield PartStartEvent(index=1, part=TextPart(content=""))
        yield PartDeltaEvent(index=1, delta=TextPartDelta(content_delta="第二段"))
        yield PartEndEvent(index=1, part=TextPart(content="第二段"))

    live = await _live(_projector(), stream())
    derived = _derived(
        ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
        ModelResponse(
            parts=[TextPart(content="第一段"), TextPart(content="第二段")],
            run_id=RUN,
            timestamp=_at(1),
        ),
    )

    assert [frame.frame_id for frame in live[0].steps[0].frames] == ["t1.1.f1", "t1.1.f2"]
    assert _shape(live) == _shape(derived)


async def test_a_compaction_notice_lands_on_the_same_step_on_both_paths() -> None:
    """压缩提示关联之后的第一步：实时等待步骤创建，历史按边界时间定位。"""

    summary = "Summary of previous conversation:\n\n## Intent\n翻 README"
    projector = _projector()

    async def stream() -> AsyncIterator[Any]:
        yield PartStartEvent(index=0, part=TextPart(content=""))
        yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="先读"))
        yield PartEndEvent(index=0, part=TextPart(content="先读"))
        yield FunctionToolCallEvent(part=ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"))
        yield FunctionToolResultEvent(
            part=ToolReturnPart(tool_name="Read", content="x", tool_call_id="c1")
        )
        projector.note_compaction(summary)
        yield PartStartEvent(index=0, part=TextPart(content=""))
        yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="读完了"))
        yield PartEndEvent(index=0, part=TextPart(content="读完了"))

    live = await _live(projector, stream())
    derived = _derived(
        ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
        ModelResponse(
            parts=[
                TextPart(content="先读"),
                ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"),
            ],
            run_id=RUN,
            timestamp=_at(1),
        ),
        ModelRequest(
            parts=[ToolReturnPart(tool_name="Read", content="x", tool_call_id="c1")],
            run_id=RUN,
            timestamp=_at(2),
        ),
        # 边界时间位于第一步与第二步响应之间。
        ModelResponse(
            parts=[CompactionPart(content=summary, provider_name="function")],
            run_id=RUN,
            timestamp=_at(3),
        ),
        ModelResponse(parts=[TextPart(content="读完了")], run_id=RUN, timestamp=_at(4)),
    )

    assert [frame.frame_id for frame in live[0].steps[1].frames] == ["t1.2.compaction", "t1.2.f1"]
    assert _shape(live) == _shape(derived)


# --- 子代理任务的收尾 ---------------------------------------------------------


def test_a_replayed_delegation_points_the_card_at_the_latest_child_only() -> None:
    """崩溃续跑会重放同一次 delegate；账本只记最后一个子运行，父卡也只能指向它。"""

    baseline = TranscriptTurn(
        turn_id="t1",
        ordinal=1,
        state="running",
        origin=TurnOrigin(kind="user"),
        content=CONTENT,
        steps=(
            TranscriptStep(
                step_id="t1.1",
                turn_id="t1",
                ordinal=1,
                state="interrupted",
                frames=(
                    ToolFrame(
                        frame_id="t1.1.c1",
                        tool_call_id="c1",
                        name=DELEGATE_TOOL,
                        state="running",
                        agent_refs=(AgentRef(agent_id="old-child", role="child"),),
                    ),
                ),
            ),
        ),
    )
    projector = TranscriptEventStream(
        turn_id="t1", turn_ordinal=1, resume_from=baseline, display=DISPLAYS
    )

    frame_op, _task_op = projector.note_subagent("c1", "new-child", WRITER)

    assert isinstance(frame_op, FrameUpsertOp)
    assert frame_op.step_id == "t1.1"
    assert isinstance(frame_op.frame, ToolFrame)
    assert frame_op.frame.agent_refs == (AgentRef(agent_id="new-child", role="child"),)


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

    call = ToolCallPart(
        tool_name=DELEGATE_TOOL, args={"agent_name": WRITER, "task": TASK}, tool_call_id="c1"
    )
    live = TranscriptStore()
    projector = _projector()

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
