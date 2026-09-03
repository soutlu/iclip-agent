"""两条路必须产出同一份 transcript。

实时那条：引擎事件流 → 投影器 → 操作 → 落到实时状态。
历史那条：落库的消息 → ``from_messages``。

同一段对话，客户端在跑的时候看到的是前者、刷新之后看到的是后者。两边只要有一个 id 或一段
文字不一样，界面就会在刷新的瞬间变形，而且没有任何报错。所以这条测试比单看哪一侧都重要。

时刻不参与比较：前者按事件到达的真实时刻走，后者按消息上记的时刻走，本来就不同。用量也不比
——它由 ``AgentRunResultEvent`` 在 run 跑完时一次补齐，而这些用例是手工喂事件的，不发那一条。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic_ai.exceptions import RunCancelled
from pydantic_ai.messages import (
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
"""两条路都收这一份。都用默认的空注册表时，卡上的画法与渲染器比对会平凡地通过。"""

MEDIA_GRID = {"items": [{"url": "https://cdn.test/s1-1.jpg", "caption": "S1-1"}]}
"""给人看的那份结果。造成 dict 而不是模型对象：历史那侧从库里解出来的就是 dict。"""


def _skeleton(turns: tuple[TranscriptTurn, ...]) -> list[dict[str, Any]]:
    """只留下两边都该一致的那些：结构、id、正文。"""

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
                            # 工具卡整张比：参数、画法、渲染器与给人看的那份在结局到达时最容易
                            # 被漏掉，而漏了不报错。
                            getattr(frame, "input", None),
                            getattr(frame, "display", None),
                            getattr(frame, "view", None),
                            getattr(frame, "metadata", None),
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
    """把事件流喂给投影器，把产出的操作落到实时状态，取回它拼出来的轮子。"""

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
    """历史那侧。终态由运行侧从官方的 run 结束事件记下来给进去，推导器自己不猜。"""

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
    """一步里三种块都有，而且工具块不占 f 号——两边的编号规则必须同一套。"""

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
    # 钉住画出来的不是兜底那张：两条路都退成 generic 时上面那句照样成立。
    assert getattr(live_card, "display", None) == FileIoDisplay(operation="read", path="/README.md")
    assert _skeleton(live) == _skeleton(derived)


@pytest.mark.anyio
async def test_the_result_for_people_lands_on_the_same_card_on_both_paths() -> None:
    """``ToolReturn.metadata`` 原样进帧：实时那侧从事件上的 part 读，历史那侧从落库的 part 读。"""

    call = ToolCallPart(tool_name="Read", args={"path": "/a.md"}, tool_call_id="c1")
    live = await _project(
        [
            # 只有工具调用的一次响应也先流出它那块 part：这一步就是在这里开出来的，没有它
            # 投影器会把后面的派活当成上一轮遗留的调用丢掉。
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
    # 钉住比的不是两边都空：漏了字段时上面那句照样成立。
    assert (live_card.view, live_card.metadata) == ("file_content", MEDIA_GRID)
    assert _skeleton(live) == _skeleton(derived)


@pytest.mark.anyio
async def test_a_cancelled_turn_needs_its_state_handed_to_the_deriver() -> None:
    """这是两条路唯一推不平的地方，钉在这里免得实现时被当成偶然。

    被停掉的运行，实时那侧从 ``on_cancelled`` 知道它是 ``cancelled``；消息那侧只看得出「没停
    在一条最终响应上」，分不清是被停的还是报错的，只能给 ``failed``。所以运行那一层必须把终态
    传给推导器（``run_states``），否则同一轮在刷新前后会从「已取消」变成「失败」。
    """

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
    # 没给终态就是「没记下一次干净的收尾」，不能默认当成跑完了。
    assert turns_from_messages(messages)[0].state == "failed"
    assert _skeleton(live) == _skeleton(_derive(messages, state="cancelled"))


@pytest.mark.anyio
async def test_two_steps_match() -> None:
    """工具调完再问一次模型就是新的一步，块号从头开始。"""

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
    """插话进来时块在哪一步、排第几，两边必须一致。

    ``EnqueuedMessagesEvent`` 是在下一次模型请求前排空的，那时上一步的块已经收尾、步号还指着
    上一步——所以它落在上一步的末尾。推导那侧也是把它接在上一步已有块的后面。这条不靠推理，
    靠这里比对。
    """

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
    """一次响应里连着两个正文 part。

    基类会给第二个打上 ``follows_text``。我们两条路都按「一个 part 一个块」编号，所以这里的
    契约是**不合并**——kimi 自己是合并的，但决定我们界面会不会在刷新时变形的是我们这两条路一
    致，不是与 kimi 一致。
    """

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
    """逐字追加按 UTF-16 记位置。算错了不会报错，只会让客户端反复整页重拉。"""

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
"""图夹在两句话中间、两张图连着、还有一条视频。

第三张的地址缩不动（不是 OSS 的），进模型那一串里它只留一条空标签——与前两张的「开标签 +
像素 + 闭标签」不是一个形状，两种都得还原得回来。
"""


@pytest.mark.anyio
async def test_mixed_content_is_the_same_on_both_paths() -> None:
    """图文混排那串 part 两条路给出同一份，次序不动。

    界面按这份列表画，图落在哪句话旁边全看它：两条路只要有一处不一样，刷新的瞬间图就换了位置。
    """

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
