"""从消息历史推出 transcript：已经跑完的那些轮子。

实时那条路（投影器）从事件流产出操作，这条路从 ``StepPersistence`` 存下来的消息现推。
两条路必须给出**逐字相同**的结构，否则同一段对话刷新前后会变形——所以编号一律取自消息
里确定的事实，不取到达次序（规则见 ``ops`` 模块开头）。

分轮不查表：消息自己带着 ``run_id``。一次 run 就是一轮（审批由
``HandleDeferredToolCalls`` 在同一次 run 里等掉，不会把一轮劈成两次）。

**轮的终态不在这里猜。** 消息里看不出一次 run 是跑完的、被停的还是报错的：真实数据里有一段
对话的消息停在一条没有工具调用的响应上（看着像正常收尾），官方记的却是被取消。

官方一直在记这件事——``StepPersistence`` 每次 run 结束会写一条 ``run_completed`` 或
``run_failed``（后者把 ``repr(error)`` 存进 ``error`` 列，取消因此认得出来）。分类规则见
``run_state_from_events``；按 ``run_id`` 查那张表即可，``turn_states`` 收的就是这个键。没查
到的轮子给 ``failed``——「没记下一次干净的收尾」就是这个意思，不能默认当成跑完了。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Literal

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.usage import RequestUsage
from pydantic_ai_harness.step_persistence import StepEvent

from iclip.harness.transcript.prompt_media import read_prompt_items
from iclip.platform.transcript.display import tool_display
from iclip.platform.transcript.ops import (
    TOOL_STATE_BY_OUTCOME,
    Attachment,
    StepUsage,
    TextFrame,
    ThinkingFrame,
    ToolFrame,
    TranscriptFrame,
    TranscriptStep,
    TranscriptTurn,
    TurnOrigin,
    TurnUsage,
    next_frame_ordinal,
)

TurnState = Literal["queued", "running", "completed", "failed", "cancelled"]


def turns_from_messages(
    messages: Sequence[ModelMessage],
    *,
    turn_states: Mapping[str, TurnState] | None = None,
) -> tuple[TranscriptTurn, ...]:
    """把一段对话的消息历史推成一串轮子，按发生先后排。

    ``turn_states`` 按 ``run_id`` 给终态，来自官方记的那条 run 结束事件（见模块开头）。
    """

    states = turn_states or {}
    return tuple(
        _turn(group, ordinal=ordinal, state=states.get(run_id, "failed"))
        for ordinal, (run_id, group) in enumerate(_group_by_run(messages), start=1)
    )


def run_ids_from_messages(messages: Sequence[ModelMessage]) -> tuple[str, ...]:
    """这段对话跑过哪几次 run，按发生先后排。拿去查每次 run 的结束事件。"""

    return tuple(run_id for run_id, _ in _group_by_run(messages))


def run_state_from_events(events: Sequence[StepEvent]) -> TurnState:
    """一次 run 的结束事件 → 轮的终态。

    取消与报错都写成 ``run_failed``，区别在 ``error`` 那一列的异常名：第一方取消是
    ``RunCancelled``，外部取消（任务被 cancel）是 ``CancelledError``。一条结束事件都没有说明
    进程没活到写它——那也不是跑完了。
    """

    for event in reversed(events):
        if event.kind == "run_completed":
            return "completed"
        if event.kind == "run_failed":
            error = event.error or ""
            return "cancelled" if error.startswith(("RunCancelled", "CancelledError")) else "failed"
    return "failed"


def _group_by_run(messages: Sequence[ModelMessage]) -> list[tuple[str, list[ModelMessage]]]:
    """按 ``run_id`` 分组，组间按组内第一条消息的时刻排。

    不按 ``runs`` 表的 ``started_at`` 排：那会把这一层重新拴回一张表上，而消息里本来就带着
    分组和时刻两样东西。
    """

    grouped: dict[str, list[ModelMessage]] = {}
    current = ""
    for message in messages:
        # 没有 run_id 的挂到前一条那次 run 上。收尾的重试提示就是这样的（引擎没给它盖号），
        # 单独成组的话会多出一个空轮子，而且它的时刻也是空的，排序会把它甩到最前面。
        current = message.run_id or current
        grouped.setdefault(current, []).append(message)
    return sorted(grouped.items(), key=lambda item: _started_at(item[1]))


_EPOCH = datetime.min.replace(tzinfo=UTC)


def _started_at(group: Sequence[ModelMessage]) -> datetime:
    """这一组最早的时刻。请求的 ``timestamp`` 允许为空，所以取第一个有值的。"""

    return next((at for message in group if (at := _at(message)) is not None), _EPOCH)


def _ended_at(group: Sequence[ModelMessage]) -> datetime | None:
    return next((at for message in reversed(group) if (at := _at(message)) is not None), None)


def _at(message: ModelMessage) -> datetime | None:
    return message.timestamp


def _iso(moment: datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


def _turn(group: Sequence[ModelMessage], *, ordinal: int, state: TurnState) -> TranscriptTurn:
    turn_id = f"t{ordinal}"
    steps: list[TranscriptStep] = []
    # 工具卡建在发起它的那一步里，而它的结局在下一条请求里才到，所以按 toolCallId 记着位置。
    tool_frames: dict[str, str] = {}
    frames_by_step: list[dict[str, TranscriptFrame]] = []
    prompt: str | None = None
    pending_request: ModelRequest | None = None
    pending_steers: list[str] = []
    attached: dict[str, Attachment] = {}

    for message in group:
        if isinstance(message, ModelRequest):
            prompt_text, attachments = _user_content(message)
            attached.update({item.attachment_id: item for item in attachments})
            if prompt is None and prompt_text is not None:
                # 一轮的第一句用户输入是这一轮的由来，不单独成块。
                prompt = prompt_text
            elif prompt_text is not None and steps:
                # 中途插进来的用户消息（插话）挂在当时开着的那一步末尾，与实时那条路一致。
                index = len(steps) - 1
                _user_frame(frames_by_step[index], f"{turn_id}.{index + 1}", prompt_text)
            elif prompt_text is not None:
                # 还没有步可挂（第一次模型请求就带着插话进来），攒着，等第一步开出来放在最前。
                pending_steers.append(prompt_text)
            _settle_tools(message, tool_frames, frames_by_step)
            pending_request = message
            continue

        step_ordinal = len(steps) + 1
        step_id = f"{turn_id}.{step_ordinal}"
        frames: dict[str, TranscriptFrame] = {}
        frames_by_step.append(frames)
        for text in pending_steers:
            _user_frame(frames, step_id, text)
        pending_steers.clear()
        _open_frames(message, step_id=step_id, frames=frames, tool_frames=tool_frames)
        steps.append(
            TranscriptStep(
                step_id=step_id,
                turn_id=turn_id,
                ordinal=step_ordinal,
                state="completed",
                started_at=_iso(None if pending_request is None else pending_request.timestamp),
                ended_at=_iso(message.timestamp),
                usage=step_usage(message.usage),
                finish_reason=message.finish_reason,
            )
        )

    return TranscriptTurn(
        turn_id=turn_id,
        ordinal=ordinal,
        state=state,
        origin=TurnOrigin(kind="user"),
        prompt=prompt,
        attachment_ids=tuple(attached) or None,
        started_at=_iso(_started_at(group)),
        ended_at=_iso(_ended_at(group)),
        usage=_turn_usage(steps),
        steps=tuple(
            step.model_copy(update={"frames": tuple(frames_by_step[index].values())})
            for index, step in enumerate(steps)
        ),
    )


def _user_frame(frames: dict[str, TranscriptFrame], step_id: str, text: str) -> None:
    """把一条用户消息放进这一步，编号走 ``_next_frame_ordinal``。"""

    frame_id = f"{step_id}.f{next_frame_ordinal(frames)}"
    frames[frame_id] = TextFrame(frame_id=frame_id, role="user", text=text)


def _user_content(message: ModelRequest) -> tuple[str | None, list[Attachment]]:
    """这条请求里用户说的话与附上的东西；没有用户输入就是 ``(None, [])``。

    ``content`` 可以是一串多模态元素。附件的身份写在正文里的媒体 tag 上（见
    ``prompt_media``），这里把它解回协议的 ``attachment`` 实体——不解的话那条 tag 会当成用户
    打的字显示出来，而附件在界面上根本不存在。
    """

    texts: list[str] = []
    attachments: list[Attachment] = []
    for part in message.parts:
        if not isinstance(part, UserPromptPart):
            continue
        items = [part.content] if isinstance(part.content, str) else list(part.content)
        found_texts, found_attachments = read_prompt_items(items)
        texts.extend(found_texts)
        attachments.extend(found_attachments)
    return ("\n".join(texts) if texts else None), attachments


def _open_frames(
    message: ModelResponse,
    *,
    step_id: str,
    frames: dict[str, TranscriptFrame],
    tool_frames: dict[str, str],
) -> None:
    """一次模型响应里的各个 part → 这一步的块。

    正文块与思考块共用一个从 1 起的序号；工具块不占这个号，它的 id 是
    ``<步 id>.<toolCallId>``（协议里工具块 id 就是这么定的，反解不出序号）。
    """

    for part in message.parts:
        if isinstance(part, ThinkingPart):
            frame_id = f"{step_id}.f{next_frame_ordinal(frames)}"
            frames[frame_id] = ThinkingFrame(frame_id=frame_id, text=part.content)
        elif isinstance(part, TextPart):
            frame_id = f"{step_id}.f{next_frame_ordinal(frames)}"
            frames[frame_id] = TextFrame(frame_id=frame_id, role="assistant", text=part.content)
        elif isinstance(part, ToolCallPart):
            frame_id = f"{step_id}.{part.tool_call_id}"
            frames[frame_id] = ToolFrame(
                frame_id=frame_id,
                tool_call_id=part.tool_call_id,
                name=part.tool_name,
                state="running",
                input=part.args,
                display=tool_display(part.tool_name, part.args),
            )
            tool_frames[part.tool_call_id] = frame_id


def _settle_tools(
    message: ModelRequest,
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
) -> None:
    """把工具的结局回填到它那张卡上。

    ``RetryPromptPart`` 也走这里：工具的参数没通过校验时，它顶替了那次调用的返回，卡片就该
    是错的那一档——漏了它，界面上会留下一张永远转圈的卡。
    """

    for part in message.parts:
        if isinstance(part, ToolReturnPart):
            state = TOOL_STATE_BY_OUTCOME.get(part.outcome, "error")
            _replace_tool(
                part.tool_call_id,
                tool_frames,
                frames_by_step,
                state=state,
                output=part.content,
                error=None if state == "done" else str(part.content),
            )
        elif isinstance(part, RetryPromptPart):
            _replace_tool(
                part.tool_call_id,
                tool_frames,
                frames_by_step,
                state="error",
                output=None,
                error=str(part.content),
            )


def _replace_tool(
    tool_call_id: str,
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
    *,
    state: Literal["done", "error"],
    output: object,
    error: str | None,
) -> None:
    frame_id = tool_frames.get(tool_call_id)
    if frame_id is None:
        return
    for step_frames in frames_by_step:
        existing = step_frames.get(frame_id)
        if isinstance(existing, ToolFrame):
            step_frames[frame_id] = existing.model_copy(
                update={"state": state, "output": output, "error": error}
            )
            return


def step_usage(usage: RequestUsage | None) -> StepUsage | None:
    """引擎的用量 → 协议的用量。实时那条路补用量时用的是同一个函数，口径只有一份。

    ``input_tokens`` 是总数，缓存读写都算在里面（官方 docstring 明说 included in），所以
    「其余」要把两块缓存都减掉，不然三项加起来会超过总数。
    """

    if usage is None:
        return None
    return StepUsage(
        input_other=usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens,
        output=usage.output_tokens,
        input_cache_read=usage.cache_read_tokens,
        input_cache_creation=usage.cache_write_tokens,
    )


def _turn_usage(steps: Sequence[TranscriptStep]) -> TurnUsage | None:
    """一轮的用量是各步之和，口径照协议：写缓存算进 input，读缓存单列。"""

    counted = [step.usage for step in steps if step.usage is not None]
    if not counted:
        return None
    return TurnUsage(
        input_tokens=sum(item.input_other + item.input_cache_creation for item in counted),
        cached_tokens=sum(item.input_cache_read for item in counted),
        output_tokens=sum(item.output for item in counted),
    )


__all__ = [
    "TurnState",
    "run_ids_from_messages",
    "run_state_from_events",
    "step_usage",
    "turns_from_messages",
]
