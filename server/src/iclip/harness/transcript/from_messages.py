"""从消息历史推出 transcript：已经跑完的那些轮子。

实时那条路（投影器）从事件流产出操作，这条路从 ``StepPersistence`` 存下来的消息现推。
两条路必须给出**逐字相同**的结构，否则同一段对话刷新前后会变形——所以编号一律取自消息
里确定的事实，不取到达次序（规则见 ``ops`` 模块开头）。

一轮 = 一条 prompt 起过的全部 run。消息自己带着 ``run_id``，哪几次 run 属于同一条 prompt 由
``agent_job_runs`` 那张表给（调用方查好递进来），没有映射的 run 各自成轮。轮间按组内最早那条消息
的时刻排。

**轮的终态不在这里猜。** 消息里看不出一次 run 是跑完的、被停的还是报错的：真实数据里有一段
对话的消息停在一条没有工具调用的响应上（看着像正常收尾），官方记的却是被取消。

官方一直在记这件事——``StepPersistence`` 每次 run 结束会写一条 ``run_completed`` 或
``run_failed``（后者把 ``repr(error)`` 存进 ``error`` 列，取消因此认得出来）。分类规则见
``run_state_from_events``；按 ``run_id`` 查那张表即可，``turn_states`` 收的就是这个键。没查
到的轮子给 ``failed``——「没记下一次干净的收尾」就是这个意思，不能默认当成跑完了。

**等审批的那一轮也不在这里猜。** 一次 run 干净收尾、末尾那条响应上却还开着工具调用，只有
「以 ``DeferredToolRequests`` 结束」这一种可能；那几次调用是不是还等着人点头，要看那条 prompt
此刻是什么状态（``prompt_status_of_run``）。判据与各自的结局见 ``_approval_calls``。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Final, Literal, cast

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
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.platform.transcript.ops import (
    APPROVAL_ID_PREFIX,
    TOOL_STATE_BY_OUTCOME,
    Attachment,
    Interaction,
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

ApprovalState = Literal["pending", "approved", "rejected", "cancelled"]

_CLOSED_OUT_OUTCOMES: Final = ("failed", "interrupted")
"""补给悬空调用的那两种返回结局，都不是人点的头：``failed`` 是新消息进来之前把前沿收掉（见
``runner._close_out``），``interrupted`` 是崩溃续跑时官方自己补的。"""

_WAITING_PROMPT_STATUSES: Final = ("awaiting", "running")
"""还会有人来读那几张审批卡的两种 prompt 状态：正等着点头，或者点齐了已经起了续跑。"""

_TURN_STATE_BY_PROMPT: Final[dict[str, TurnState]] = {
    "awaiting": "running",
    "running": "running",
    "aborted": "cancelled",
    "failed": "failed",
}
"""末尾还开着审批调用时，轮的终态按那条 prompt 的状态定，不按结束事件——那次 run 是干净收尾的，
按它算这一轮会显示成「跑完了」，而人还没点头。"""


def turns_from_messages(
    messages: Sequence[ModelMessage],
    *,
    turn_states: Mapping[str, TurnState] | None = None,
    turn_errors: Mapping[str, str | None] | None = None,
    prompt_of_run: Mapping[str, str] | None = None,
    prompt_status_of_run: Mapping[str, str] | None = None,
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
) -> tuple[TranscriptTurn, ...]:
    """把一段对话的消息历史推成一串轮子，按发生先后排。

    ``turn_states`` 与 ``turn_errors`` 都按 ``run_id`` 给，来自官方记的那条 run 结束事件（见模块
    开头）。错误文字得跟着一起来：实时那侧把它挂在轮头部，这侧不给就两条路对不上。

    ``prompt_of_run`` 是 run → prompt 的映射，多次 run 合成一轮靠它。轮的终态取该轮**最后一次**
    run 的：更早那几次是中断后续跑掉的，它们的结局只定各自的步。``prompt_status_of_run`` 是
    run → 那条 prompt 此刻的状态，只在末尾还开着审批调用时用得上（见 ``_approval_calls``）。

    ``display`` 是工具卡的画法，实时那侧要拿到同一份实例；不给就每张卡都退成 generic，而且不
    报错。
    """

    states = turn_states or {}
    errors = turn_errors or {}
    statuses = prompt_status_of_run or {}
    turns: list[TranscriptTurn] = []
    for ordinal, segments in enumerate(_group_by_turn(messages, prompt_of_run or {}), start=1):
        last_run = segments[-1][0]
        settled, waiting = _approval_calls(segments, states)
        prompt_status = statuses.get(last_run)
        from_events = states.get(last_run, "failed")
        turns.append(
            _turn(
                segments,
                ordinal=ordinal,
                state=(
                    _TURN_STATE_BY_PROMPT.get(prompt_status or "", from_events)
                    if waiting
                    else from_events
                ),
                error=errors.get(last_run),
                run_states=states,
                approvals=(*settled, *waiting),
                waiting=waiting if prompt_status in _WAITING_PROMPT_STATUSES else (),
                display=display,
            )
        )
    return tuple(turns)


def approvals_from_messages(
    messages: Sequence[ModelMessage],
    *,
    turn_states: Mapping[str, TurnState] | None = None,
    prompt_of_run: Mapping[str, str] | None = None,
    prompt_status_of_run: Mapping[str, str] | None = None,
) -> tuple[Interaction, ...]:
    """这段对话里的审批交互：已经落定的那些，加末尾还等着人点头的那几张。

    判据与工具卡上那个审批 id 同一份（``_approval_calls``）。还开着的那几张按 prompt 状态定：
    等审批或者已经起了续跑 → ``pending``，撤销与失败 → ``cancelled``，因为再没有 run 会来读它，
    而界面上一张永远等回应的卡比一条已取消的记录难看得多。
    """

    states = turn_states or {}
    statuses = prompt_status_of_run or {}
    items: list[Interaction] = []
    for segments in _group_by_turn(messages, prompt_of_run or {}):
        settled, waiting = _approval_calls(segments, states)
        items.extend(_approval(item, state) for item, state in settled.items())
        pending = statuses.get(segments[-1][0]) in _WAITING_PROMPT_STATUSES
        items.extend(_approval(item, "pending" if pending else "cancelled") for item in waiting)
    return tuple(items)


def _approval(tool_call_id: str, state: ApprovalState) -> Interaction:
    return Interaction(
        interaction_id=f"{APPROVAL_ID_PREFIX}{tool_call_id}",
        interaction_kind="approval",
        tool_call_id=tool_call_id,
        state=state,
    )


def _approval_calls(
    segments: Sequence[tuple[str, Sequence[ModelMessage]]],
    run_states: Mapping[str, TurnState],
) -> tuple[dict[str, ApprovalState], tuple[str, ...]]:
    """这一轮里哪几次工具调用是审批：已经落定的各自什么结局，末尾那几个还开着。

    判据只有这两条，别再加：**一段干净收尾**（官方记下了 ``run_completed``）却在末尾那条响应上
    留着没有结果的调用——只有以 ``DeferredToolRequests`` 结束才会是这个形状，崩在工具执行中途
    留下的形状一样，但那一段不是干净收尾；结局看同一轮后一段第一条请求里的返回，``denied`` 是
    拒了，其余是放行了，而补上的 ``failed`` / ``interrupted`` 不算（见 ``_CLOSED_OUT_OUTCOMES``）。
    """

    settled: dict[str, ApprovalState] = {}
    open_calls: tuple[str, ...] = ()
    for index, (run_id, group) in enumerate(segments):
        first = group[0] if group else None
        if index > 0 and open_calls and isinstance(first, ModelRequest):
            for part in first.parts:
                if not isinstance(part, ToolReturnPart) or part.tool_call_id not in open_calls:
                    continue
                if part.outcome in _CLOSED_OUT_OUTCOMES:
                    continue
                settled[part.tool_call_id] = "rejected" if part.outcome == "denied" else "approved"
        open_calls = unanswered_tool_calls(group) if run_states.get(run_id) == "completed" else ()
    return settled, open_calls


def run_ids_from_messages(messages: Sequence[ModelMessage]) -> tuple[str, ...]:
    """这段对话跑过哪几次 run，按发生先后排。拿去查每次 run 的结束事件。"""

    return tuple(run_id for run_id, _ in _group_by_run(messages))


def turn_run_ids(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> tuple[tuple[str, ...], ...]:
    """每一轮各含哪几次 run，按轮序排。轮号 ``t{N}`` 的 N 就是这份列表的长度。"""

    return tuple(
        tuple(run_id for run_id, _ in segments)
        for segments in _group_by_turn(messages, prompt_of_run)
    )


def drop_last_turn(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> tuple[list[ModelMessage], tuple[str, ...]]:
    """把最后一轮的消息摘出去，返回（剩下的消息，被摘掉那一轮的 run id）。

    末轮跨了几次 run 就一起摘：留一段下来的话它会与续跑的那条 prompt 断开映射，自成一轮。
    剩下的消息重新分轮后轮号不变，下一轮的轮号（``len(turn_run_ids) + 1``）自然复用被摘掉
    那一轮的号。消息是空的就没什么可摘。
    """

    turns = _group_by_turn(messages, prompt_of_run)
    if not turns:
        return [], ()
    kept = [message for segments in turns[:-1] for _, group in segments for message in group]
    return kept, tuple(run_id for run_id, _ in turns[-1])


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


def run_error_from_events(events: Sequence[StepEvent]) -> str | None:
    """这次 run 失败时官方记下的错误文字。跑完的、或者没记下结束事件的都是 ``None``。

    实时那侧把这段文字挂在轮头部的 ``error`` 上，这一侧得给出同一份，否则刷新之后失败的原因
    就没了，两条路也对不上。
    """

    for event in reversed(events):
        if event.kind == "run_completed":
            return None
        if event.kind == "run_failed":
            return event.error
    return None


def _group_by_turn(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> list[list[tuple[str, list[ModelMessage]]]]:
    """把 run 分组再合成轮：相邻两组归同一条 prompt 就是同一轮。

    只合相邻的——同一条 prompt 的几次 run 在时间上必然挨着。两组都没有映射时不合（``agent_job_runs``
    建表之前的旧数据，各自成轮）。
    """

    turns: list[list[tuple[str, list[ModelMessage]]]] = []
    for run_id, group in _group_by_run(messages):
        prompt_id = prompt_of_run.get(run_id)
        if turns and prompt_id is not None and prompt_of_run.get(turns[-1][-1][0]) == prompt_id:
            turns[-1].append((run_id, group))
        else:
            turns.append([(run_id, group)])
    return turns


def _group_by_run(messages: Sequence[ModelMessage]) -> list[tuple[str, list[ModelMessage]]]:
    """按 ``run_id`` 分组，组间按组内第一条消息的时刻排。

    排序取消息上的时刻，不取 ``runs`` 表的 ``started_at``：消息里本来就带着时刻。合成轮要的那份
    映射另说，它来自 ``agent_job_runs``（见 ``_group_by_turn``）。
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


def _turn(
    segments: Sequence[tuple[str, Sequence[ModelMessage]]],
    *,
    ordinal: int,
    state: TurnState,
    error: str | None = None,
    run_states: Mapping[str, TurnState],
    approvals: Sequence[str] = (),
    waiting: Sequence[str] = (),
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
) -> TranscriptTurn:
    """一轮的那几次 run → 一轮。步号跨 run 接着数，工具卡在哪一段发起就留在那一段。

    ``approvals`` 是这一轮里要盖审批 id 的那几次调用，``waiting`` 是其中还等着人点头的——后者
    的卡留在 ``running``，别的没等到返回的照旧收成错的那一档。
    """

    turn_id = f"t{ordinal}"
    steps: list[TranscriptStep] = []
    # 工具卡建在发起它的那一步里，而它的结局在下一条请求里才到，所以按 toolCallId 记着位置。
    # 结局可能落在后一次 run 的第一条请求里（续跑时给悬空调用补的那份），所以这些账跨段留着。
    tool_frames: dict[str, str] = {}
    frames_by_step: list[dict[str, TranscriptFrame]] = []
    prompt: str | None = None
    pending_request: ModelRequest | None = None
    pending_steers: list[str] = []
    attached: dict[str, Attachment] = {}

    for index, (run_id, group) in enumerate(segments):
        opened = len(steps)
        for message in group:
            if isinstance(message, ModelRequest):
                prompt_text, attachments = _user_content(message)
                attached.update({item.attachment_id: item for item in attachments})
                if prompt is None and prompt_text is not None:
                    # 一轮的第一句用户输入是这一轮的由来，不单独成块。
                    prompt = prompt_text
                elif prompt_text is not None and steps:
                    # 中途插进来的用户消息挂在当时最后那一步末尾，与实时那条路一致。赶在前一段
                    # 收场那一刻递进去的那条，挂的是前一段的末步。
                    step_index = len(steps) - 1
                    _user_frame(
                        frames_by_step[step_index], f"{turn_id}.{step_index + 1}", prompt_text
                    )
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
            _open_frames(
                message,
                step_id=step_id,
                frames=frames,
                tool_frames=tool_frames,
                display=display,
            )
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

        # 这一段后面还有续跑，而它自己没跑完：那一段停在哪一步，那一步就是断掉的。
        broke_off = (
            index < len(segments) - 1
            and len(steps) > opened
            and run_states.get(run_id, "failed") != "completed"
        )
        if broke_off:
            steps[-1] = steps[-1].model_copy(update={"state": "interrupted"})

    for tool_call_id in approvals:
        _stamp_approval(tool_call_id, tool_frames, frames_by_step)
    _close_orphan_tools(tool_frames, frames_by_step, keep_open=waiting)

    messages = [message for _, group in segments for message in group]
    return TranscriptTurn(
        turn_id=turn_id,
        ordinal=ordinal,
        state=state,
        origin=TurnOrigin(kind="user"),
        prompt=prompt,
        attachment_ids=tuple(attached) or None,
        started_at=_iso(_started_at(messages)),
        ended_at=_iso(_ended_at(messages)),
        usage=_turn_usage(steps),
        error=error,
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
    display: ToolDisplayRegistry,
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
                display=display.tool_display(part.tool_name, part.args),
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


def unanswered_tool_calls(messages: Sequence[ModelMessage]) -> tuple[str, ...]:
    """最后那次模型响应里还没有结果的工具调用。

    只看最后一次响应：更早的悬空调用官方在每次请求前自己补齐（``_repair_dangling_tool_calls``），
    而最后那次是「前沿」，官方留着等调用方用 ``deferred_tool_results`` 回答——不回答就拒绝新的
    用户消息进来（``Cannot provide a new user prompt when the message history contains
    unprocessed tool calls``）。

    已经有结果的不能再给一份，官方会报「这次调用已经执行过了」。
    """

    last = next(
        (
            index
            for index in range(len(messages) - 1, -1, -1)
            if isinstance(messages[index], ModelResponse)
        ),
        None,
    )
    if last is None:
        return ()
    response = cast("ModelResponse", messages[last])
    called = [part.tool_call_id for part in response.parts if isinstance(part, ToolCallPart)]
    answered = {
        part.tool_call_id
        for message in messages[last + 1 :]
        for part in getattr(message, "parts", ())
        if isinstance(part, ToolReturnPart | RetryPromptPart)
    }
    return tuple(item for item in called if item not in answered)


ORPHAN_TOOL_ERROR = "运行中断，这次调用没有结果"
"""没有工具返回的那次调用，卡片上写这句。

一份中断的消息历史里，最后那次工具调用可能没有对应的返回（进程在工具跑到一半时没了）。不给它
一个终态，界面上会留下一张永远转圈的卡——而这一轮明明已经结束了。
"""


def _stamp_approval(
    tool_call_id: str,
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
) -> None:
    """给这张卡盖上审批 id。客户端靠它把「同意 / 拒绝」挂在这张卡上。"""

    frame_id = tool_frames.get(tool_call_id)
    if frame_id is None:
        return
    for step_frames in frames_by_step:
        existing = step_frames.get(frame_id)
        if isinstance(existing, ToolFrame):
            step_frames[frame_id] = existing.model_copy(
                update={"approval_id": f"{APPROVAL_ID_PREFIX}{tool_call_id}"}
            )
            return


def _close_orphan_tools(
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
    *,
    keep_open: Sequence[str] = (),
) -> None:
    """把没等到返回的工具卡收成错的那一档。等审批的那几张不收：人正对着它点头。"""

    for tool_call_id in tool_frames:
        if tool_call_id in keep_open:
            continue
        for step_frames in frames_by_step:
            existing = step_frames.get(tool_frames[tool_call_id])
            if isinstance(existing, ToolFrame) and existing.state == "running":
                _replace_tool(
                    tool_call_id,
                    tool_frames,
                    frames_by_step,
                    state="error",
                    output=None,
                    error=ORPHAN_TOOL_ERROR,
                )
                break


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
    "ORPHAN_TOOL_ERROR",
    "ApprovalState",
    "TurnState",
    "approvals_from_messages",
    "drop_last_turn",
    "run_error_from_events",
    "run_ids_from_messages",
    "run_state_from_events",
    "step_usage",
    "turn_run_ids",
    "turns_from_messages",
    "unanswered_tool_calls",
]
