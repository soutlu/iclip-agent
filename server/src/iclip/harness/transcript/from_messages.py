"""从持久化消息重建 transcript，结构须与实时投影一致。

同一 prompt 的全部 run 合并为一轮，无映射的 run 各自成轮，按首条消息时间排序。
终态与错误来自持久化结束事件；缺少结束事件时标记失败。
末尾开放的审批调用结合 prompt 当前状态判定，见 _approval_calls。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
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

from iclip.harness.context_compaction import compaction_boundary, compaction_only
from iclip.harness.transcript.prompt_media import plain_text, prompt_content
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.platform.transcript.ops import (
    APPROVAL_ID_PREFIX,
    COMPACTION_NOTICE,
    TOOL_STATE_BY_OUTCOME,
    AgentRef,
    Interaction,
    NoticeFrame,
    PromptContent,
    StepUsage,
    TextFrame,
    ThinkingFrame,
    ToolFrame,
    TranscriptFrame,
    TranscriptStep,
    TranscriptTask,
    TranscriptTurn,
    TurnOrigin,
    TurnUsage,
    next_frame_ordinal,
)

TurnState = Literal["queued", "running", "completed", "failed", "cancelled"]

ApprovalState = Literal["pending", "approved", "rejected", "cancelled"]

_CLOSED_OUT_OUTCOMES: Final = ("failed", "interrupted")
"""系统补全的失败结果：新消息关闭旧调用使用 failed，中断恢复使用 interrupted。"""

_WAITING_PROMPT_STATUSES: Final = ("awaiting", "running")
"""审批仍可被处理的状态：等待审批或已开始续跑。"""

_TURN_STATE_BY_PROMPT: Final[dict[str, TurnState]] = {
    "awaiting": "running",
    "running": "running",
    "aborted": "cancelled",
    "failed": "failed",
}
"""存在开放审批调用时，按 prompt 状态决定轮次终态；run_completed 不代表审批已完成。"""


def turns_from_messages(
    messages: Sequence[ModelMessage],
    *,
    turn_states: Mapping[str, TurnState] | None = None,
    turn_errors: Mapping[str, str | None] | None = None,
    prompt_of_run: Mapping[str, str] | None = None,
    prompt_status_of_run: Mapping[str, str] | None = None,
    subagent_of_call: Mapping[str, str] | None = None,
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
) -> tuple[TranscriptTurn, ...]:
    """按时间重建轮次；同 prompt 的 run 合并，轮次终态取最后一次 run。

    turn_states/turn_errors 按 run_id 提供，prompt_status_of_run 用于开放审批调用。
    subagent_of_call 把 toolCallId 映射到它派出的子代理 id，据此给工具卡补 agentRefs。
    display 须与实时投影共享，保持工具卡结构一致。
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
                subagent_of_call=subagent_of_call or {},
                display=display,
            )
        )
    return tuple(turns)


@dataclass(frozen=True, slots=True)
class ChildRun:
    """一次子代理运行的持久事实，由 history 层从运行记录与结束事件读出。"""

    run_id: str
    agent_name: str | None
    started_at: datetime
    ended_at: datetime | None
    state: TurnState


_TASK_STATE_BY_RUN: Final[dict[TurnState, str]] = {
    "completed": "completed",
    "cancelled": "killed",
}
"""子运行终态到任务终态；其余（含未收尾）一律 failed。"""


def tasks_from_messages(
    messages: Sequence[ModelMessage],
    *,
    subagent_of_call: Mapping[str, str],
    child_runs: Sequence[ChildRun],
) -> tuple[TranscriptTask, ...]:
    """把子运行重建成 subagent 任务；结果与错误取父侧那次 delegate_task 的返回。

    父侧返回找不到（子运行中途崩、账本没写上）时结果与错误都留空。
    """

    call_of_child = {child_id: call_id for call_id, child_id in subagent_of_call.items()}
    returns = _tool_returns(messages)
    tasks: list[TranscriptTask] = []
    for child in sorted(child_runs, key=lambda item: item.started_at):
        outcome = returns.get(call_of_child.get(child.run_id, ""))
        state, text = (None, None) if outcome is None else outcome
        tasks.append(
            TranscriptTask(
                task_id=child.run_id,
                kind="subagent",
                state=_TASK_STATE_BY_RUN.get(child.state, "failed"),  # pyright: ignore[reportArgumentType]
                detached=False,
                description=child.agent_name,
                agent_id=child.run_id,
                started_at=_iso(child.started_at),
                ended_at=_iso(child.ended_at),
                result_summary=text if state == "done" else None,
                error=None if state is None or state == "done" else text,
            )
        )
    return tuple(tasks)


def _tool_returns(messages: Sequence[ModelMessage]) -> dict[str, tuple[str, str]]:
    """按 toolCallId 收集工具返回的（终态, 文本），与工具卡的判定口径一致。"""

    found: dict[str, tuple[str, str]] = {}
    for message in messages:
        if not isinstance(message, ModelRequest):
            continue
        for part in message.parts:
            if isinstance(part, RetryPromptPart):
                found[part.tool_call_id] = ("error", str(part.content))
            elif isinstance(part, ToolReturnPart):
                found[part.tool_call_id] = (
                    TOOL_STATE_BY_OUTCOME.get(part.outcome, "error"),
                    str(part.content),
                )
    return found


def approvals_from_messages(
    messages: Sequence[ModelMessage],
    *,
    turn_states: Mapping[str, TurnState] | None = None,
    prompt_of_run: Mapping[str, str] | None = None,
    prompt_status_of_run: Mapping[str, str] | None = None,
) -> tuple[Interaction, ...]:
    """重建审批交互；等待审批和续跑中的调用为 pending，撤回或失败的调用为 cancelled。"""

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
    """识别正常完成的 run 末尾无结果的调用作为审批。

    结果取同轮后续 run 的返回：denied 为拒绝，其余为放行；系统补全的 failed/interrupted 排除。
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
    """按顺序返回运行 id，供查询结束事件。"""

    return tuple(run_id for run_id, _ in _group_by_run(messages))


def turn_run_ids(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> tuple[tuple[str, ...], ...]:
    """按轮序返回 run 分组，列表长度用于确定轮号。"""

    return tuple(
        tuple(run_id for run_id, _ in segments)
        for segments in _group_by_turn(messages, prompt_of_run)
    )


def drop_last_turn(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> tuple[list[ModelMessage], tuple[str, ...]]:
    """移除末轮的全部 run 并返回其 id；保留消息的轮号不变，续跑复用末轮编号。"""

    turns = _group_by_turn(messages, prompt_of_run)
    if not turns:
        return [], ()
    kept = [message for segments in turns[:-1] for _, group in segments for message in group]
    return kept, tuple(run_id for run_id, _ in turns[-1])


def run_state_from_events(events: Sequence[StepEvent]) -> TurnState:
    """将持久化结束事件映射为终态。run_failed 按 RunCancelled/CancelledError 区分取消；缺事件视为失败。"""

    for event in reversed(events):
        if event.kind == "run_completed":
            return "completed"
        if event.kind == "run_failed":
            error = event.error or ""
            return "cancelled" if error.startswith(("RunCancelled", "CancelledError")) else "failed"
    return "failed"


def run_error_from_events(events: Sequence[StepEvent]) -> str | None:
    """读取失败事件的错误文本，与实时轮次的 error 保持一致。"""

    for event in reversed(events):
        if event.kind == "run_completed":
            return None
        if event.kind == "run_failed":
            return event.error
    return None


def _group_by_turn(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> list[list[tuple[str, list[ModelMessage]]]]:
    """仅合并属于同一 prompt 的相邻 run；无映射的历史 run 保持独立。"""

    turns: list[list[tuple[str, list[ModelMessage]]]] = []
    for run_id, group in _group_by_run(messages):
        prompt_id = prompt_of_run.get(run_id)
        if turns and prompt_id is not None and prompt_of_run.get(turns[-1][-1][0]) == prompt_id:
            turns[-1].append((run_id, group))
        else:
            turns.append([(run_id, group)])
    return turns


def _group_by_run(messages: Sequence[ModelMessage]) -> list[tuple[str, list[ModelMessage]]]:
    """按 run_id 分组，以组内首条有效消息的时间排序。"""

    grouped: dict[str, list[ModelMessage]] = {}
    current = ""
    for message in messages:
        # 缺少 run_id 的重试提示归入前一 run，避免产生无时间的额外轮次。
        current = message.run_id or current
        grouped.setdefault(current, []).append(message)
    return sorted(grouped.items(), key=lambda item: _started_at(item[1]))


_EPOCH = datetime.min.replace(tzinfo=UTC)


def _started_at(group: Sequence[ModelMessage]) -> datetime:
    """取首个有效消息时间，排除压缩边界的创建时间，避免改变原轮次顺序。"""

    return next(
        (
            at
            for message in group
            if not compaction_only(message)
            if (at := _at(message)) is not None
        ),
        _EPOCH,
    )


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
    subagent_of_call: Mapping[str, str],
    approvals: Sequence[str] = (),
    waiting: Sequence[str] = (),
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
) -> TranscriptTurn:
    """跨 run 连续编号步骤；工具卡保留在发起步骤，等待审批的卡保持 running。"""

    turn_id = f"t{ordinal}"
    steps: list[TranscriptStep] = []
    # 按 toolCallId 保留卡片位置，结果可能在后续 run 的首条请求中到达。
    tool_frames: dict[str, str] = {}
    frames_by_step: list[dict[str, TranscriptFrame]] = []
    content: tuple[PromptContent, ...] | None = None
    pending_request: ModelRequest | None = None
    pending_steers: list[tuple[PromptContent, ...]] = []
    pending_summaries: list[tuple[datetime, str]] = []

    for index, (run_id, group) in enumerate(segments):
        opened = len(steps)
        for message in group:
            if (
                isinstance(message, ModelResponse)
                and (boundary := compaction_boundary(message)) is not None
            ):
                # 压缩提示挂在时间严格晚于边界的首步，不能按边界插入历史的位置决定。
                # 严格比较确保边界合并至响应后仍定位同一步。
                pending_summaries.append((message.timestamp, boundary.content or ""))
                if compaction_only(message):
                    # 纯边界消息不计为模型步骤；包含其他响应 part 时仍计一步。
                    continue
            if isinstance(message, ModelRequest):
                said = _user_content(message)
                if content is None and said:
                    # 首条用户消息属于轮次输入，不另建块。
                    content = said
                elif said and steps:
                    # 插话挂在当时的末步，与实时投影保持一致。
                    step_index = len(steps) - 1
                    _user_frame(frames_by_step[step_index], f"{turn_id}.{step_index + 1}", said)
                elif said:
                    # 首步尚未创建时暂存插话，随后插入首步开头。
                    pending_steers.append(said)
                _settle_tools(message, tool_frames, frames_by_step)
                pending_request = message
                continue

            step_ordinal = len(steps) + 1
            step_id = f"{turn_id}.{step_ordinal}"
            frames: dict[str, TranscriptFrame] = {}
            frames_by_step.append(frames)
            later: list[tuple[datetime, str]] = []
            for at, summary in pending_summaries:
                if at < message.timestamp:
                    _compaction_frame(frames, step_id, summary)
                else:
                    later.append((at, summary))
            pending_summaries = later
            for said in pending_steers:
                _user_frame(frames, step_id, said)
            pending_steers.clear()
            _open_frames(
                message,
                step_id=step_id,
                frames=frames,
                tool_frames=tool_frames,
                subagent_of_call=subagent_of_call,
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

        # 未完成且后续有续跑的 run，其末步标记为中断。
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
        content=content or (),
        started_at=_iso(_started_at(messages)),
        ended_at=_iso(_ended_at(messages)),
        usage=turn_usage([step.usage for step in steps if step.usage is not None]),
        error=error,
        steps=tuple(
            step.model_copy(update={"frames": tuple(frames_by_step[index].values())})
            for index, step in enumerate(steps)
        ),
    )


def _compaction_frame(frames: dict[str, TranscriptFrame], step_id: str, summary: str) -> None:
    """压缩提示使用独立 id，不占 .f<n> 块序号。"""

    frame_id = f"{step_id}.compaction"
    frames[frame_id] = NoticeFrame(
        frame_id=frame_id, level="info", message=COMPACTION_NOTICE, detail=summary
    )


def _user_frame(
    frames: dict[str, TranscriptFrame], step_id: str, content: tuple[PromptContent, ...]
) -> None:
    """将用户消息加入步骤，使用共享块序号。"""

    frame_id = f"{step_id}.f{next_frame_ordinal(frames)}"
    frames[frame_id] = TextFrame(
        frame_id=frame_id, role="user", text=plain_text(content), content=content
    )


def _user_content(message: ModelRequest) -> tuple[PromptContent, ...]:
    """从请求还原用户 part；媒体 tag 解析为附件，避免显示协议文本。"""

    parts: list[PromptContent] = []
    for part in message.parts:
        if not isinstance(part, UserPromptPart):
            continue
        items = [part.content] if isinstance(part.content, str) else list(part.content)
        parts.extend(prompt_content(items))
    return tuple(parts)


def _open_frames(
    message: ModelResponse,
    *,
    step_id: str,
    frames: dict[str, TranscriptFrame],
    tool_frames: dict[str, str],
    subagent_of_call: Mapping[str, str],
    display: ToolDisplayRegistry,
) -> None:
    """响应 part 转换为步骤块；正文与思考共用序号，工具使用 <stepId>.<toolCallId>。"""

    for part in message.parts:
        if isinstance(part, ThinkingPart):
            frame_id = f"{step_id}.f{next_frame_ordinal(frames)}"
            frames[frame_id] = ThinkingFrame(frame_id=frame_id, text=part.content)
        elif isinstance(part, TextPart):
            frame_id = f"{step_id}.f{next_frame_ordinal(frames)}"
            frames[frame_id] = TextFrame(frame_id=frame_id, role="assistant", text=part.content)
        elif isinstance(part, ToolCallPart):
            frame_id = f"{step_id}.{part.tool_call_id}"
            child_id = subagent_of_call.get(part.tool_call_id)
            frames[frame_id] = ToolFrame(
                frame_id=frame_id,
                tool_call_id=part.tool_call_id,
                name=part.tool_name,
                state="running",
                input=part.args,
                display=display.tool_display(part.tool_name, part.args),
                view=display.view_of(part.tool_name),
                agent_refs=(
                    None if child_id is None else (AgentRef(agent_id=child_id, role="child"),)
                ),
            )
            tool_frames[part.tool_call_id] = frame_id


def _settle_tools(
    message: ModelRequest,
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
) -> None:
    """回填工具结果；RetryPromptPart 作为失败结果关闭工具卡。"""

    for part in message.parts:
        if isinstance(part, ToolReturnPart):
            state = TOOL_STATE_BY_OUTCOME.get(part.outcome, "error")
            _replace_tool(
                part.tool_call_id,
                tool_frames,
                frames_by_step,
                state=state,
                output=part.content,
                metadata=part.metadata,
                error=None if state == "done" else str(part.content),
            )
        elif isinstance(part, RetryPromptPart):
            _replace_tool(
                part.tool_call_id,
                tool_frames,
                frames_by_step,
                state="error",
                output=None,
                metadata=None,
                error=str(part.content),
            )


def unanswered_tool_calls(messages: Sequence[ModelMessage]) -> tuple[str, ...]:
    """返回最后一次模型响应中未处理的调用。

    调用方须通过 deferred_tool_results 处理这些前沿调用，才能提交新用户消息；已完成调用不可重复返回。
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
"""无工具返回时的中断文案，用于结束已终止轮次中的开放工具卡。"""


def _stamp_approval(
    tool_call_id: str,
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
) -> None:
    """附加审批 id，供客户端关联审批操作。"""

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
    """将无结果调用标记为错误；等待审批的调用保持开放。"""

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
                    metadata=None,
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
    metadata: object,
    error: str | None,
) -> None:
    frame_id = tool_frames.get(tool_call_id)
    if frame_id is None:
        return
    for step_frames in frames_by_step:
        existing = step_frames.get(frame_id)
        if isinstance(existing, ToolFrame):
            step_frames[frame_id] = existing.model_copy(
                update={"state": state, "output": output, "metadata": metadata, "error": error}
            )
            return


def step_usage(usage: RequestUsage | None) -> StepUsage | None:
    """统一转换引擎用量；input_tokens 已含缓存读写，计算普通输入时须扣除两者。"""

    if usage is None:
        return None
    return StepUsage(
        input_other=usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens,
        output=usage.output_tokens,
        input_cache_read=usage.cache_read_tokens,
        input_cache_creation=usage.cache_write_tokens,
    )


def turn_usage(steps: Sequence[StepUsage]) -> TurnUsage | None:
    """汇总步骤用量；缓存写入计入 input，缓存读取单列。"""

    if not steps:
        return None
    return TurnUsage(
        input_tokens=sum(item.input_other + item.input_cache_creation for item in steps),
        cached_tokens=sum(item.input_cache_read for item in steps),
        output_tokens=sum(item.output for item in steps),
    )


__all__ = [
    "ORPHAN_TOOL_ERROR",
    "ApprovalState",
    "ChildRun",
    "TurnState",
    "approvals_from_messages",
    "drop_last_turn",
    "run_error_from_events",
    "run_ids_from_messages",
    "run_state_from_events",
    "step_usage",
    "tasks_from_messages",
    "turn_run_ids",
    "turn_usage",
    "turns_from_messages",
    "unanswered_tool_calls",
]
