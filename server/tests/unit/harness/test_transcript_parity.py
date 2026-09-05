"""对比引擎事件投影与历史消息推导的 transcript 结构、标识和内容。

忽略事件到达时间与消息时间的差异；手工事件不包含 AgentRunResultEvent，因此不比较用量。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic_ai.exceptions import RunCancelled
from pydantic_ai.messages import (
    CompactionPart,
    EnqueuedMessagesEvent,
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
    ThinkingPart,
    ThinkingPartDelta,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from iclip.harness.transcript.from_messages import TurnState, turns_from_messages
from iclip.harness.transcript.projector import TranscriptEventStream
from iclip.harness.transcript.prompt_media import model_prompt
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.display import (
    FileIoDisplay,
    ToolDisplay,
    ToolDisplayEntry,
    ToolDisplayRegistry,
)
from iclip.platform.transcript.ops import (
    MAIN_AGENT_ID,
    AttachmentSource,
    ImageContent,
    PromptContent,
    TextContent,
    TranscriptTurn,
    VideoContent,
)


def _read_display(args: Any) -> ToolDisplay | None:
    path = args.get("path") if isinstance(args, dict) else None
    return FileIoDisplay(operation="read", path=path) if isinstance(path, str) and path else None


CONVERSATION = "conv-1"
PROMPT = "帮我把 README 翻译成英文"
CONTENT: tuple[PromptContent, ...] = (TextContent(text=PROMPT),)
RUN = "run-a"

DISPLAYS = ToolDisplayRegistry.merged(
    {"Read": ToolDisplayEntry(draw=_read_display, view="file_content")}
)
"""使用非空注册表，避免两条路径均缺少 display 时仍通过一致性比较。"""

MEDIA_GRID = {"items": [{"url": "https://cdn.test/s1-1.jpg", "caption": "S1-1"}]}
"""用 dict 模拟数据库反序列化后的工具 metadata。"""


def _skeleton(turns: tuple[TranscriptTurn, ...]) -> list[dict[str, Any]]:

    return [
        {
            "turn": (turn.turn_id, turn.ordinal, turn.state, turn.content),
            "steps": [
                {
                    "step": (step.step_id, step.ordinal, step.state),
                    "frames": [
                        (
                            frame.frame_id,
                            frame.kind,
                            getattr(frame, "text", None),
                            getattr(frame, "role", None),
                            getattr(frame, "content", None),
                            getattr(frame, "state", None),
                            # 比较完整工具卡，覆盖参数、display、renderer 和 metadata 的遗漏。
                            getattr(frame, "input", None),
                            getattr(frame, "display", None),
                            getattr(frame, "view", None),
                            getattr(frame, "metadata", None),
                            # 比较压缩提示内容，避免仅 id 和类型相同而正文不同。
                            getattr(frame, "message", None),
                            getattr(frame, "detail", None),
                        )
                        for frame in step.frames
                    ],
                }
                for step in turn.steps
            ],
        }
        for turn in turns
    ]


async def _project(
    events: list[Any], *, content: tuple[PromptContent, ...] = CONTENT
) -> tuple[TranscriptTurn, ...]:
    """将事件投影操作应用到实时状态，返回轮列表。"""

    async def stream() -> AsyncIterator[Any]:
        for event in events:
            yield event

    projector = TranscriptEventStream(
        turn_id="t1", turn_ordinal=1, content=content, display=DISPLAYS
    )
    store = TranscriptStore()
    async for batch in projector.transform_stream(stream()):
        store.append(CONVERSATION, MAIN_AGENT_ID, batch)
    return store.subscribe_view(CONVERSATION, MAIN_AGENT_ID).live_turns


def _at(minute: int) -> datetime:
    return datetime(2026, 8, 30, 9, minute, tzinfo=UTC)


def _messages(*messages: ModelMessage) -> list[ModelMessage]:
    return list(messages)


def _derive(
    messages: list[ModelMessage], *, state: TurnState = "completed"
) -> tuple[TranscriptTurn, ...]:
    """从历史消息推导 transcript，运行终态由调用方显式传入。"""

    return turns_from_messages(messages, turn_states={RUN: state}, display=DISPLAYS)


@pytest.mark.anyio
async def test_text_only_turn_matches_the_derived_one() -> None:
    live = await _project(
        [
            PartStartEvent(index=0, part=TextPart(content="")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="好的")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="，我来看看")),
            PartEndEvent(index=0, part=TextPart(content="好的，我来看看")),
        ]
    )
    derived = _derive(
        _messages(
            ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
            ModelResponse(parts=[TextPart(content="好的，我来看看")], run_id=RUN, timestamp=_at(1)),
        )
    )

    assert _skeleton(live) == _skeleton(derived)


@pytest.mark.anyio
async def test_thinking_then_text_then_tool_matches() -> None:

    live = await _project(
        [
            PartStartEvent(index=0, part=ThinkingPart(content="")),
            PartDeltaEvent(index=0, delta=ThinkingPartDelta(content_delta="先读一下")),
            PartEndEvent(index=0, part=ThinkingPart(content="先读一下")),
            PartStartEvent(index=1, part=TextPart(content="")),
            PartDeltaEvent(index=1, delta=TextPartDelta(content_delta="这就去读")),
            PartEndEvent(index=1, part=TextPart(content="这就去读")),
            FunctionToolCallEvent(
                part=ToolCallPart(tool_name="Read", args={"path": "/README.md"}, tool_call_id="c1")
            ),
            FunctionToolResultEvent(
                part=ToolReturnPart(tool_name="Read", content="# iclip", tool_call_id="c1")
            ),
            PartStartEvent(index=0, part=TextPart(content="")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="读完了")),
            PartEndEvent(index=0, part=TextPart(content="读完了")),
        ]
    )
    derived = _derive(
        _messages(
            ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
            ModelResponse(
                parts=[
                    ThinkingPart(content="先读一下"),
                    TextPart(content="这就去读"),
                    ToolCallPart(tool_name="Read", args={"path": "/README.md"}, tool_call_id="c1"),
                ],
                run_id=RUN,
                timestamp=_at(1),
            ),
            ModelRequest(
                parts=[ToolReturnPart(tool_name="Read", content="# iclip", tool_call_id="c1")],
                run_id=RUN,
                timestamp=_at(2),
            ),
            ModelResponse(parts=[TextPart(content="读完了")], run_id=RUN, timestamp=_at(3)),
        )
    )

    live_card = next(
        frame for frame in live[0].steps[0].frames if getattr(frame, "kind", None) == "tool"
    )
    # 确认未同时回退为 generic，避免相等断言掩盖注册遗漏。
    assert getattr(live_card, "display", None) == FileIoDisplay(operation="read", path="/README.md")
    assert _skeleton(live) == _skeleton(derived)


@pytest.mark.anyio
async def test_the_result_for_people_lands_on_the_same_card_on_both_paths() -> None:

    call = ToolCallPart(tool_name="Read", args={"path": "/a.md"}, tool_call_id="c1")
    live = await _project(
        [
            # 纯工具调用也须先发送 part 以创建步骤，避免后续调用被当作历史遗留事件丢弃。
            PartStartEvent(index=0, part=call),
            PartEndEvent(index=0, part=call),
            FunctionToolCallEvent(part=call),
            FunctionToolResultEvent(
                part=ToolReturnPart(
                    tool_name="Read", content="出好了", tool_call_id="c1", metadata=MEDIA_GRID
                )
            ),
            PartStartEvent(index=0, part=TextPart(content="")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="好了")),
            PartEndEvent(index=0, part=TextPart(content="好了")),
        ]
    )
    derived = _derive(
        _messages(
            ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
            ModelResponse(parts=[call], run_id=RUN, timestamp=_at(1)),
            ModelRequest(
                parts=[
                    ToolReturnPart(
                        tool_name="Read", content="出好了", tool_call_id="c1", metadata=MEDIA_GRID
                    )
                ],
                run_id=RUN,
                timestamp=_at(2),
            ),
            ModelResponse(parts=[TextPart(content="好了")], run_id=RUN, timestamp=_at(3)),
        )
    )

    live_card = next(frame for frame in live[0].steps[0].frames if frame.kind == "tool")
    assert (live_card.view, live_card.metadata) == ("file_content", MEDIA_GRID)
    assert _skeleton(live) == _skeleton(derived)


@pytest.mark.anyio
async def test_a_cancelled_turn_needs_its_state_handed_to_the_deriver() -> None:
    """消息形状无法区分取消与失败，运行层必须将 run_states 传给历史推导器。"""

    events: list[Any] = [
        PartStartEvent(index=0, part=TextPart(content="")),
        PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="在做了")),
        PartEndEvent(index=0, part=TextPart(content="在做了")),
    ]

    async def stream() -> AsyncIterator[Any]:
        for event in events:
            yield event
        raise RunCancelled("用户停止")

    projector = TranscriptEventStream(
        turn_id="t1", turn_ordinal=1, content=CONTENT, display=DISPLAYS
    )
    store = TranscriptStore()
    async for batch in projector.transform_stream(stream()):
        store.append(CONVERSATION, MAIN_AGENT_ID, batch)
    live = store.subscribe_view(CONVERSATION, MAIN_AGENT_ID).live_turns

    messages = _messages(
        ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
        ModelResponse(parts=[TextPart(content="在做了")], run_id=RUN, timestamp=_at(1)),
        ModelRequest(parts=[], run_id=RUN, timestamp=_at(2)),
    )

    assert live[0].state == "cancelled"
    assert turns_from_messages(messages)[0].state == "failed"
    assert _skeleton(live) == _skeleton(_derive(messages, state="cancelled"))


@pytest.mark.anyio
async def test_two_steps_match() -> None:

    live = await _project(
        [
            PartStartEvent(index=0, part=TextPart(content="")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="先读")),
            PartEndEvent(index=0, part=TextPart(content="先读")),
            FunctionToolCallEvent(part=ToolCallPart(tool_name="Read", args={}, tool_call_id="c1")),
            FunctionToolResultEvent(
                part=ToolReturnPart(tool_name="Read", content="x", tool_call_id="c1")
            ),
            PartStartEvent(index=0, part=TextPart(content="")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="读完了")),
            PartEndEvent(index=0, part=TextPart(content="读完了")),
        ]
    )
    derived = _derive(
        _messages(
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
            ModelResponse(parts=[TextPart(content="读完了")], run_id=RUN, timestamp=_at(3)),
        )
    )

    assert _skeleton(live) == _skeleton(derived)


@pytest.mark.anyio
async def test_a_steer_between_two_steps_lands_in_the_same_place() -> None:
    """EnqueuedMessagesEvent 在下一请求前处理，此时步骤号仍指向上一步；追加消息应接在该步末尾。"""

    live = await _project(
        [
            PartStartEvent(index=0, part=TextPart(content="")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="在做了")),
            PartEndEvent(index=0, part=TextPart(content="在做了")),
            FunctionToolCallEvent(part=ToolCallPart(tool_name="Read", args={}, tool_call_id="c1")),
            EnqueuedMessagesEvent(
                enqueue_id="e1",
                messages=(ModelRequest(parts=[UserPromptPart(content="改成英文")]),),
            ),
            FunctionToolResultEvent(
                part=ToolReturnPart(tool_name="Read", content="x", tool_call_id="c1")
            ),
            PartStartEvent(index=0, part=TextPart(content="")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="好")),
            PartEndEvent(index=0, part=TextPart(content="好")),
        ]
    )
    derived = _derive(
        _messages(
            ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
            ModelResponse(
                parts=[
                    TextPart(content="在做了"),
                    ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"),
                ],
                run_id=RUN,
                timestamp=_at(1),
            ),
            ModelRequest(
                parts=[
                    ToolReturnPart(tool_name="Read", content="x", tool_call_id="c1"),
                    UserPromptPart(content="改成英文"),
                ],
                run_id=RUN,
                timestamp=_at(2),
            ),
            ModelResponse(parts=[TextPart(content="好")], run_id=RUN, timestamp=_at(3)),
        )
    )

    assert _skeleton(live) == _skeleton(derived)


@pytest.mark.anyio
async def test_two_adjacent_text_parts_stay_two_frames_on_both_paths() -> None:
    """相邻正文 part 保持独立块；即使标记 follows_text，实时与历史也不合并。"""

    live = await _project(
        [
            PartStartEvent(index=0, part=TextPart(content="")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="第一段")),
            PartEndEvent(index=0, part=TextPart(content="第一段")),
            PartStartEvent(index=1, part=TextPart(content="")),
            PartDeltaEvent(index=1, delta=TextPartDelta(content_delta="第二段")),
            PartEndEvent(index=1, part=TextPart(content="第二段")),
        ]
    )
    derived = _derive(
        _messages(
            ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
            ModelResponse(
                parts=[TextPart(content="第一段"), TextPart(content="第二段")],
                run_id=RUN,
                timestamp=_at(1),
            ),
        )
    )

    assert [frame.frame_id for frame in live[0].steps[0].frames] == ["t1.1.f1", "t1.1.f2"]
    assert _skeleton(live) == _skeleton(derived)


@pytest.mark.anyio
async def test_emoji_text_survives_the_utf16_offsets() -> None:

    live = await _project(
        [
            PartStartEvent(index=0, part=TextPart(content="")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="好的👍")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="继续")),
            PartEndEvent(index=0, part=TextPart(content="好的👍继续")),
        ]
    )
    derived = _derive(
        _messages(
            ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
            ModelResponse(parts=[TextPart(content="好的👍继续")], run_id=RUN, timestamp=_at(1)),
        )
    )

    assert _skeleton(live) == _skeleton(derived)


_OSS = "https://bkt.oss-cn-hangzhou.aliyuncs.com/u"
MIXED: tuple[PromptContent, ...] = (
    TextContent(text="参考这张图："),
    ImageContent(source=AttachmentSource(kind="url", url=f"{_OSS}/a.png")),
    TextContent(text="再连着两张："),
    ImageContent(source=AttachmentSource(kind="url", url=f"{_OSS}/b.png")),
    ImageContent(source=AttachmentSource(kind="url", url="https://cdn.test/c.png")),
    VideoContent(source=AttachmentSource(kind="url", url=f"{_OSS}/clip.mp4")),
    TextContent(text="做个 30 秒的"),
)
"""覆盖文字间插图、相邻图片、视频，以及不可缩放地址生成的空标签。"""


@pytest.mark.anyio
async def test_mixed_content_is_the_same_on_both_paths() -> None:

    live = await _project(
        [
            PartStartEvent(index=0, part=TextPart(content="")),
            PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="好")),
            PartEndEvent(index=0, part=TextPart(content="好")),
        ],
        content=MIXED,
    )
    derived = _derive(
        _messages(
            ModelRequest(
                parts=[UserPromptPart(content=model_prompt(MIXED))],
                run_id=RUN,
                timestamp=_at(0),
            ),
            ModelResponse(parts=[TextPart(content="好")], run_id=RUN, timestamp=_at(1)),
        )
    )

    assert live[0].content == MIXED
    assert derived[0].content == MIXED


@pytest.mark.anyio
async def test_a_compaction_notice_lands_on_the_same_step_on_both_paths() -> None:
    """压缩提示关联之后的第一步：实时等待步骤创建，历史按边界时间定位。"""

    summary = "Summary of previous conversation:\n\n## Intent\n翻 README"

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

    projector = TranscriptEventStream(
        turn_id="t1", turn_ordinal=1, content=CONTENT, display=DISPLAYS
    )
    store = TranscriptStore()
    async for batch in projector.transform_stream(stream()):
        store.append(CONVERSATION, MAIN_AGENT_ID, batch)
    live = store.subscribe_view(CONVERSATION, MAIN_AGENT_ID).live_turns

    derived = _derive(
        _messages(
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
    )

    assert [frame.frame_id for frame in live[0].steps[1].frames] == ["t1.2.compaction", "t1.2.f1"]
    assert _skeleton(live) == _skeleton(derived)
