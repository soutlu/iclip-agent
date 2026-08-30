"""实时那一份：把引擎的事件流投影成 transcript 操作。

这是官方 ``UIEventStream`` 的一个子类——``ag_ui`` 与 ``vercel_ai`` 是它的另外两个。官方在
``pydantic_ai/ui/AGENTS.md`` 里点明了我们这种用法：事件不经 HTTP 请求、而是走自己的传输
（队列、WebSocket 扇出）时，流可以脱离请求单独构造，在传输边缘再编码。

**产出必须与 ``from_messages`` 逐字相同。** 那一侧从落库的消息现推同一段对话，两边只要有
一个 id 不一样，同一段对话在刷新前后就会变形。所以编号一律走共享的规则（``ops`` 模块开头
那几条 + ``next_frame_ordinal``），不按到达次序。

一次 run 就是一轮：审批由 ``HandleDeferredToolCalls`` 在同一次 run 里等掉，不会把一轮劈成
两次，所以这里不需要「认领上一次留下的半截状态」那套。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import KW_ONLY, dataclass, field
from datetime import UTC, datetime
from typing import Any

from pydantic_ai.exceptions import RunCancelled
from pydantic_ai.messages import (
    DeferredToolRequestsEvent,
    DeferredToolResultsEvent,
    EnqueuedMessagesEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    RetryPromptPart,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
    UserPromptPart,
)
from pydantic_ai.ui import UIEventStream
from pydantic_ai.usage import RequestUsage

from iclip.harness.transcript.ops import (
    MAIN_AGENT_ID,
    AppendOp,
    EmittableOperation,
    FrameTarget,
    FrameUpsertOp,
    Interaction,
    InteractionUpsertOp,
    MetaMergeOp,
    NoticeFrame,
    StepHeader,
    StepUpsertOp,
    StepUsage,
    TextFrame,
    ThinkingFrame,
    ToolFrame,
    TranscriptMeta,
    TurnHeader,
    TurnOrigin,
    TurnUpsertOp,
    TurnUsage,
    next_frame_ordinal,
    utf16_len,
)

OpsBatch = tuple[EmittableOperation, ...]
"""一次产出。一批就是一个批次号，所以钩子里要一次 yield 完，不要拆成几次。"""

_TOOL_STATE = {"success": "done", "failed": "error", "denied": "error", "interrupted": "error"}


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class TranscriptEventStream(UIEventStream[Any, OpsBatch, Any, Any]):
    """把一次 run 投影成一轮的操作流。

    ``turn_id`` 与 ``turn_ordinal`` 由外面给：轮号在收下 prompt 时就分配好了，不由这里数。
    """

    _: KW_ONLY

    agent_id: str = MAIN_AGENT_ID
    turn_id: str = "t1"
    turn_ordinal: int = 1
    prompt: str | None = None

    _started_at: str = field(default_factory=_now, init=False)
    _step_ordinal: int = field(default=0, init=False)
    _frame_ids: list[str] = field(default_factory=list[str], init=False)
    """当前这一步已经有的块 id。下一个正文/思考块的号由它算出来。"""
    _open_frame_id: str | None = field(default=None, init=False)
    _open_text: str = field(default="", init=False)
    _step_usage: list[StepUsage] = field(default_factory=list[StepUsage], init=False)
    _pending_steers: list[str] = field(default_factory=list[str], init=False)
    """还没有步可挂的插话，等下一步开出来放在最前面（与 ``from_messages`` 同一条规则）。"""

    # --- 编码 ---------------------------------------------------------------

    def encode_event(self, event: OpsBatch) -> str:
        """一批操作 → 线上的 JSON。批次号不在这里加：它由实时状态那一侧发。"""

        return json.dumps(
            [op.model_dump(by_alias=True, exclude_none=True) for op in event],
            ensure_ascii=False,
        )

    # --- 一轮的开合 ---------------------------------------------------------

    async def before_stream(self) -> AsyncIterator[OpsBatch]:
        yield (
            TurnUpsertOp(turn=self._turn_header(state="running")),
            MetaMergeOp(meta=TranscriptMeta(activity="turn")),
        )

    async def after_stream(self) -> AsyncIterator[OpsBatch]:
        if self._cancelled is not None or self._closed_with_error:
            # 终态已经由 on_cancelled / on_error 发过了，别再盖一个「跑完了」上去。
            return
        yield (
            TurnUpsertOp(turn=self._turn_header(state="completed")),
            MetaMergeOp(meta=TranscriptMeta(activity="idle")),
        )

    async def on_cancelled(self, cancelled: RunCancelled) -> AsyncIterator[OpsBatch]:
        yield (
            TurnUpsertOp(turn=self._turn_header(state="cancelled")),
            MetaMergeOp(meta=TranscriptMeta(activity="idle")),
        )

    async def on_error(self, error: Exception) -> AsyncIterator[OpsBatch]:
        self._closed_with_error = True
        frame_id = self._next_frame_id()
        yield (
            FrameUpsertOp(
                turn_id=self.turn_id,
                step_id=self._step_id,
                frame=NoticeFrame(frame_id=frame_id, level="error", message=str(error)),
            ),
            TurnUpsertOp(turn=self._turn_header(state="failed", error=str(error))),
            MetaMergeOp(meta=TranscriptMeta(activity="idle")),
        )

    # --- 一步的开合 ---------------------------------------------------------

    async def before_response(self) -> AsyncIterator[OpsBatch]:
        self._step_ordinal += 1
        self._frame_ids = []
        ops: list[EmittableOperation] = [
            StepUpsertOp(turn_id=self.turn_id, step=self._step(state="running"))
        ]
        for text in self._pending_steers:
            ops.extend(self._user_frame(text))
        self._pending_steers.clear()
        yield tuple(ops)

    async def after_response(self) -> AsyncIterator[OpsBatch]:
        if self._step_ordinal == 0:
            return
        yield (StepUpsertOp(turn_id=self.turn_id, step=self._step(state="completed")),)

    # --- 正文与思考 ---------------------------------------------------------

    async def handle_text_start(
        self, part: TextPart, follows_text: bool = False
    ) -> AsyncIterator[OpsBatch]:
        async for batch in self._open_text_frame(part.content, thinking=False):
            yield batch

    async def handle_text_delta(self, delta: TextPartDelta) -> AsyncIterator[OpsBatch]:
        async for batch in self._append(delta.content_delta):
            yield batch

    async def handle_text_end(
        self, part: TextPart, followed_by_text: bool = False
    ) -> AsyncIterator[OpsBatch]:
        async for batch in self._flush(TextFrame, role="assistant"):
            yield batch

    async def handle_thinking_start(
        self, part: ThinkingPart, follows_thinking: bool = False
    ) -> AsyncIterator[OpsBatch]:
        async for batch in self._open_text_frame(part.content, thinking=True):
            yield batch

    async def handle_thinking_delta(self, delta: ThinkingPartDelta) -> AsyncIterator[OpsBatch]:
        async for batch in self._append(delta.content_delta or ""):
            yield batch

    async def handle_thinking_end(
        self, part: ThinkingPart, followed_by_thinking: bool = False
    ) -> AsyncIterator[OpsBatch]:
        async for batch in self._flush(ThinkingFrame):
            yield batch

    # --- 工具 ---------------------------------------------------------------

    async def handle_function_tool_call(
        self, event: FunctionToolCallEvent
    ) -> AsyncIterator[OpsBatch]:
        """派活时才建卡：这时参数是完整的，与从消息推出来的那份一致。

        逐字到达的参数增量不建卡——那条路上参数还是半截的，两边会对不上。
        """

        frame_id = f"{self._step_id}.{event.part.tool_call_id}"
        yield (
            FrameUpsertOp(
                turn_id=self.turn_id,
                step_id=self._step_id,
                frame=ToolFrame(
                    frame_id=frame_id,
                    tool_call_id=event.part.tool_call_id,
                    name=event.part.tool_name,
                    state="running",
                    input=event.part.args,
                ),
            ),
        )

    async def handle_function_tool_result(
        self, event: FunctionToolResultEvent
    ) -> AsyncIterator[OpsBatch]:
        part = event.part
        if isinstance(part, RetryPromptPart):
            state, output, error = "error", None, str(part.content)
        else:
            state = _TOOL_STATE.get(part.outcome, "error")
            output = part.content
            error = None if state == "done" else str(part.content)
        frame_id = f"{self._step_id}.{part.tool_call_id}"
        yield (
            FrameUpsertOp(
                turn_id=self.turn_id,
                step_id=self._step_id,
                frame=ToolFrame(
                    frame_id=frame_id,
                    tool_call_id=part.tool_call_id,
                    name=part.tool_name or "",
                    state=state,  # pyright: ignore[reportArgumentType]
                    output=output,
                    error=error,
                ),
            ),
        )

    # --- 审批与插话 ---------------------------------------------------------

    async def handle_deferred_tool_requests(
        self, event: DeferredToolRequestsEvent
    ) -> AsyncIterator[OpsBatch]:
        """这些工具在等人点头。这一轮仍是 running——等人不是停下。"""

        ops = [
            InteractionUpsertOp(
                interaction=Interaction(
                    interaction_id=f"apr_{part.tool_call_id}",
                    interaction_kind="approval",
                    tool_call_id=part.tool_call_id,
                    state="pending",
                )
            )
            for part in event.requests.approvals
        ]
        if ops:
            yield tuple(ops)

    async def handle_deferred_tool_results(
        self, event: DeferredToolResultsEvent
    ) -> AsyncIterator[OpsBatch]:
        """人点过了。被放行的工具接着走常规管线，卡片的结局由工具结果那条路回填。"""

        ops = [
            InteractionUpsertOp(
                interaction=Interaction(
                    interaction_id=f"apr_{tool_call_id}",
                    interaction_kind="approval",
                    tool_call_id=tool_call_id,
                    state="approved" if approved else "rejected",
                )
            )
            for tool_call_id, approved in _approvals(event.results)
        ]
        if ops:
            yield tuple(ops)

    async def handle_enqueued_messages(
        self, event: EnqueuedMessagesEvent
    ) -> AsyncIterator[OpsBatch]:
        """插话真的送进去了。挂在当时开着的那一步末尾，与从消息推出来的那份一致。"""

        texts = [
            item
            for message in event.messages
            for part in getattr(message, "parts", ())
            if isinstance(part, UserPromptPart)
            for item in _prompt_texts(part)
        ]
        if not texts:
            return
        if self._step_ordinal == 0:
            self._pending_steers.extend(texts)
            return
        ops: list[EmittableOperation] = []
        for text in texts:
            ops.extend(self._user_frame(text))
        yield tuple(ops)

    # --- 内部 ---------------------------------------------------------------

    _closed_with_error: bool = field(default=False, init=False)

    @property
    def _step_id(self) -> str:
        return f"{self.turn_id}.{max(self._step_ordinal, 1)}"

    def _turn_header(self, *, state: str, error: str | None = None) -> TurnHeader:
        return TurnHeader(
            turn_id=self.turn_id,
            ordinal=self.turn_ordinal,
            state=state,  # pyright: ignore[reportArgumentType]
            origin=TurnOrigin(kind="user"),
            prompt=self.prompt,
            started_at=self._started_at,
            ended_at=None if state == "running" else _now(),
            usage=self._turn_usage(),
            error=error,
        )

    def _step(self, *, state: str) -> StepHeader:
        return StepHeader(
            step_id=self._step_id,
            turn_id=self.turn_id,
            ordinal=max(self._step_ordinal, 1),
            state=state,  # pyright: ignore[reportArgumentType]
            ended_at=None if state == "running" else _now(),
        )

    def _turn_usage(self) -> TurnUsage | None:
        if not self._step_usage:
            return None
        return TurnUsage(
            input_tokens=sum(u.input_other + u.input_cache_creation for u in self._step_usage),
            cached_tokens=sum(u.input_cache_read for u in self._step_usage),
            output_tokens=sum(u.output for u in self._step_usage),
        )

    def _next_frame_id(self) -> str:
        frame_id = f"{self._step_id}.f{next_frame_ordinal(self._frame_ids)}"
        self._frame_ids.append(frame_id)
        return frame_id

    def _user_frame(self, text: str) -> list[EmittableOperation]:
        frame_id = self._next_frame_id()
        return [
            FrameUpsertOp(
                turn_id=self.turn_id,
                step_id=self._step_id,
                frame=TextFrame(frame_id=frame_id, role="user", text=text),
            )
        ]

    async def _open_text_frame(self, initial: str, *, thinking: bool) -> AsyncIterator[OpsBatch]:
        """开一个空块，再把这个 part 已经带着的那点内容追加进去。

        建块时正文一律是空串、内容全靠 ``append`` 长出来——协议的 ``offset`` 是相对块内已有
        长度算的，建块就带内容会让第一条追加的位置对不上。
        """

        frame_id = self._next_frame_id()
        self._open_frame_id = frame_id
        self._open_text = ""
        ops: list[EmittableOperation] = [
            FrameUpsertOp(
                turn_id=self.turn_id,
                step_id=self._step_id,
                frame=(
                    ThinkingFrame(frame_id=frame_id, text="")
                    if thinking
                    else TextFrame(frame_id=frame_id, role="assistant", text="")
                ),
            )
        ]
        ops.extend(self._append_ops(initial))
        yield tuple(ops)

    async def _append(self, text: str) -> AsyncIterator[OpsBatch]:
        ops = self._append_ops(text)
        if ops:
            yield tuple(ops)

    def _append_ops(self, text: str) -> list[EmittableOperation]:
        if not text or self._open_frame_id is None:
            return []
        op = AppendOp(
            target=FrameTarget(
                turn_id=self.turn_id, step_id=self._step_id, frame_id=self._open_frame_id
            ),
            # 位置是块内已有内容的 UTF-16 长度。用 Python 的 len() 会在遇到 emoji 时错位，
            # 而且不报错——客户端会陷进「报缺口 → 整页重拉 → 还是对不上」的循环。
            offset=utf16_len(self._open_text),
            text=text,
        )
        self._open_text += text
        return [op]

    async def _flush(self, frame: type[Any], **extra: Any) -> AsyncIterator[OpsBatch]:
        """块收尾时把整块内容再发一次。

        前面那些逐字追加全丢了也不要紧，这一条会把完整文字盖上去——协议敢把逐字帧标成易逝、
        断线不补，靠的就是这一条兜底。
        """

        if self._open_frame_id is None:
            return
        frame_id, text = self._open_frame_id, self._open_text
        self._open_frame_id = None
        self._open_text = ""
        yield (
            FrameUpsertOp(
                turn_id=self.turn_id,
                step_id=self._step_id,
                frame=frame(frame_id=frame_id, text=text, **extra),
            ),
        )

    def record_usage(self, usage: RequestUsage | None) -> None:
        """记下这一步的用量，供轮的合计使用。口径见 ``from_messages``。"""

        if usage is None:
            return
        self._step_usage.append(
            StepUsage(
                input_other=usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens,
                output=usage.output_tokens,
                input_cache_read=usage.cache_read_tokens,
                input_cache_creation=usage.cache_write_tokens,
            )
        )


def _prompt_texts(part: UserPromptPart) -> list[str]:
    if isinstance(part.content, str):
        return [part.content]
    return [item for item in part.content if isinstance(item, str)]


def _approvals(results: Any) -> list[tuple[str, bool]]:
    """从 ``DeferredToolResults`` 里读出每个工具调用是被放行还是被拒。"""

    settled: list[tuple[str, bool]] = []
    for tool_call_id, decision in getattr(results, "approvals", {}).items():
        approved = decision if isinstance(decision, bool) else getattr(decision, "approved", True)
        settled.append((tool_call_id, bool(approved)))
    return settled


__all__ = ["OpsBatch", "TranscriptEventStream"]
