"""从持久化队列运行消息，协调停止、插话与审批。

停止使用 cancellation_token，确保框架发送终态；task.cancel() 无法进入其常规异常收尾。
插话通过 capability 捕获 RunContext，并立即 enqueue(asap)，让框架结束前的 drain 能消费晚到消息。
未消费消息在收尾时退回队列。
审批以 DeferredToolRequests 结束 run，持久化快照与 awaiting 状态，决定齐备后启动续跑。
运行独立于提交请求和客户端连接。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

import structlog
from pydantic_ai import Agent, CancellationToken, ToolFailed
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import (
    INTERRUPTED_TOOL_RETURN_CONTENT,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    UserContent,
)
from pydantic_ai.tools import DeferredToolResults, RunContext
from pydantic_ai_harness.compaction import (
    ContextUsage,
    ReportContextUsage,
    SummarizingCompaction,
)
from pydantic_ai_harness.step_persistence import ContinuableSnapshot, ToolEffectRecord

from iclip.common.errors import Conflict, NotFound
from iclip.harness.context_compaction import ContextCompaction
from iclip.harness.jobs import JobQueue, JobRow, JobStatus
from iclip.harness.transcript.from_messages import (
    ORPHAN_TOOL_ERROR,
    run_ids_from_messages,
    turn_run_ids,
    unanswered_tool_calls,
)
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.projector import TranscriptEventStream
from iclip.harness.transcript.prompt_media import model_prompt
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.platform.transcript.ops import (
    APPROVAL_ID_PREFIX,
    MAIN_AGENT_ID,
    EmittableOperation,
    FrameUpsertOp,
    Interaction,
    InteractionUpsertOp,
    MetaMergeOp,
    PromptUpsertOp,
    StepHeader,
    StepUpsertOp,
    ToolFrame,
    TranscriptMeta,
    TranscriptTurn,
    TurnHeader,
    TurnUpsertOp,
    agent_context_status,
)

_logger = structlog.stdlib.get_logger(__name__)

DepsFor = Callable[[JobRow], Awaitable[Any]]

TurnEnded = Callable[[JobRow], Awaitable[None]]
"""由组合根注入的轮次完成回调；异常仅记录，不影响已持久化的运行结果。"""
"""为消息构造运行依赖；身份固定为消息入队时的属主，由组合根提供具体依赖。"""


class ConversationSnapshots(Protocol):
    """运行所需的快照与副作用存储协议；save_snapshot 用于持久化框架未保存的审批历史。"""

    async def latest_conversation_snapshot(
        self, *, conversation_id: str, include_interrupted: bool = False
    ) -> ContinuableSnapshot | None: ...  # pragma: no cover

    async def save_snapshot(self, snapshot: ContinuableSnapshot) -> None: ...  # pragma: no cover

    async def list_unresolved_tool_effects(
        self, *, run_id: str
    ) -> list[ToolEffectRecord]: ...  # pragma: no cover


def _now() -> datetime:
    return datetime.now(UTC)


def _close_out(history: Sequence[ModelMessage]) -> DeferredToolResults | None:
    """提交新消息前，为历史前沿未处理的调用补充 ToolFailed 结果。

    不用于崩溃续跑；裸字符串会被视为成功返回，因此必须使用失败类型。
    文案复用框架修复常量，副作用事实仍以工具账本为准。
    deferred_tool_results 无法表达框架原生的 interrupted 标记。
    """

    pending = unanswered_tool_calls(history)
    if not pending:
        return None
    return DeferredToolResults(
        calls={item: ToolFailed(INTERRUPTED_TOOL_RETURN_CONTENT) for item in pending}
    )


def _approvals_of(row: JobRow, history: Sequence[ModelMessage]) -> DeferredToolResults:
    """将完整审批决定转换为 DeferredToolResults；缺少前沿调用的决定时抛错。"""

    pending = unanswered_tool_calls(history)
    missing = [item for item in pending if item not in row.decisions]
    if missing:
        raise RuntimeError(f"这几次调用还没有审批结果，续跑起不来：{missing}")
    return DeferredToolResults(approvals={item: row.decisions[item] for item in pending})


def _seed_ops(
    turn: TranscriptTurn, *, last_step_interrupted: bool
) -> tuple[EmittableOperation, ...]:
    """按轮、步、块的依赖顺序写入实时基线。

    last_step_interrupted 仅用于崩溃续跑，审批续跑的末步仍为正常结束。
    """

    ops: list[EmittableOperation] = [
        TurnUpsertOp(
            turn=TurnHeader.model_validate(
                turn.model_dump(exclude={"steps"}) | {"state": "running"}
            )
        )
    ]
    for index, step in enumerate(turn.steps):
        header = StepHeader.model_validate(step.model_dump(exclude={"frames"}))
        if last_step_interrupted and index == len(turn.steps) - 1:
            # 崩溃续跑显式标记旧末步中断，与后续历史重建一致。
            header = header.model_copy(update={"state": "interrupted"})
        ops.append(StepUpsertOp(turn_id=turn.turn_id, step=header))
        ops.extend(
            FrameUpsertOp(turn_id=turn.turn_id, step_id=step.step_id, frame=frame)
            for frame in step.frames
        )
    return tuple(ops)


@dataclass
class _RunHandle(AbstractCapability[Any]):
    """捕获 RunContext 以递入消息；pending_messages 为 run 级共享列表，首次 context 可供整轮使用。"""

    ctx: RunContext[Any] | None = None

    async def before_run(self, ctx: RunContext[Any]) -> None:
        self.ctx = ctx

    def deliver(self, content: list[UserContent]) -> str | None:
        """整条递入多模态追加并返回入队 id；运行 context 尚未就绪时返回 None。"""

        if self.ctx is None:
            return None
        return self.ctx.enqueue(*content, priority="asap")

    def undelivered(self, enqueue_ids: Iterable[str]) -> tuple[str, ...]:
        """返回仍在框架队列中等待消费的入队 id。"""

        if self.ctx is None or self.ctx.pending_messages is None:
            return tuple(enqueue_ids)
        waiting = {message.enqueue_id for message in self.ctx.pending_messages}
        return tuple(item for item in enqueue_ids if item in waiting)


@dataclass(slots=True)
class _Active:
    """活跃轮次及其控制句柄。"""

    prompt_id: str
    conversation_id: str
    run_id: str
    turn_id: str
    token: CancellationToken
    handle: _RunHandle
    steered: dict[str, str] = field(default_factory=dict[str, str])
    """框架入队 id 到 prompt id 的映射，供收尾处理插话。"""


class ConversationRunner:
    """按会话串行运行持久化消息。"""

    def __init__(
        self,
        *,
        agents: dict[str, Agent[Any, Any]],
        store: TranscriptStore,
        queue: JobQueue,
        snapshots: ConversationSnapshots,
        history: TranscriptHistory,
        deps_for: DepsFor,
        context_limits: Mapping[str, int],
        heartbeat_seconds: int,
        lease_seconds: int,
        sweep_seconds: int,
        max_attempts: int,
        compaction_max_fraction: float = 0.85,
        compaction_keep_messages: int = 20,
        locked_by: str | None = None,
        on_turn_ended: TurnEnded | None = None,
        display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
    ) -> None:
        self._agents = agents
        self._store = store
        self._queue = queue
        self._snapshots = snapshots
        self._history = history
        self._deps_for = deps_for
        self._context_limits = context_limits
        self._heartbeat_seconds = heartbeat_seconds
        self._lease_seconds = lease_seconds
        self._sweep_seconds = sweep_seconds
        self._max_attempts = max_attempts
        self._compaction_max_fraction = compaction_max_fraction
        self._compaction_keep_messages = compaction_keep_messages
        # 与 TranscriptHistory 共享展示规则，保证刷新前后工具卡一致。
        self._display = display
        # 公开租约持有者 id，供提交入口写入租约。
        self.locked_by = locked_by or uuid.uuid4().hex
        self._on_turn_ended = on_turn_ended
        self._active: dict[str, _Active] = {}
        self._closing = False
        # 持有任务强引用，避免仅被 asyncio 弱引用的运行任务被回收。
        self._tasks: set[asyncio.Task[None]] = set()
        # 后台循环独立保存，关停时先于活跃运行停止。
        self._loops: tuple[asyncio.Task[None], ...] = ()

    # --- 收下与排程 ---------------------------------------------------------

    async def submit(self, row: JobRow) -> JobRow:
        """广播已入队消息，并启动取得执行位置的运行。"""

        self._publish(row)
        if row.status == "running":
            self._spawn(row)
        return row

    async def start(self) -> None:
        """首次清扫后启动心跳与清扫循环。"""

        await self.sweep_once()
        self._loops = (
            asyncio.create_task(self._loop(self._heartbeat_seconds, self.heartbeat_once)),
            asyncio.create_task(self._loop(self._sweep_seconds, self.sweep_once)),
        )

    async def heartbeat_once(self) -> None:
        """刷新本进程租约；失租运行通过框架取消，避免与新持有者并行执行。"""

        alive = set(await self._queue.heartbeat(locked_by=self.locked_by))
        for active in tuple(self._active.values()):
            if active.prompt_id in alive:
                continue
            _logger.warning("这一轮的租约已经不在手上，取消它", prompt_id=active.prompt_id)
            active.token.cancel()

    async def sweep_once(self) -> None:
        """标记耗尽的中断运行、认领可续跑任务并唤醒空闲队列；关停期间不创建新运行。"""

        for row in await self._queue.fail_exhausted(
            lease_seconds=self._lease_seconds, max_attempts=self._max_attempts
        ):
            self._publish(row)
            if row.run_id is None:
                continue
            for child in await self._queue.settle_steered(row.run_id, status="failed", now=_now()):
                self._publish(child)
        if self._closing:
            return
        for row in await self._queue.claim_interrupted(
            locked_by=self.locked_by,
            lease_seconds=self._lease_seconds,
            max_attempts=self._max_attempts,
        ):
            self._publish(row)
            self._spawn(row)
        for conversation_id in await self._queue.conversations_waiting():
            row = await self._queue.start_next(conversation_id, locked_by=self.locked_by)
            if row is not None:
                self._publish(row)
                self._spawn(row)

    async def _loop(self, seconds: int, once: Callable[[], Awaitable[None]]) -> None:
        """周期执行并记录异常，保持租约续期与清扫循环持续运行。"""

        while True:
            await asyncio.sleep(seconds)
            try:
                await once()
            except Exception:
                _logger.exception("后台循环这一轮没做完")

    async def shutdown(self) -> None:
        """先标记关停并停止后台循环，再通过框架取消活跃运行，等待收尾。

        关停标记阻止收尾启动队首消息；排队记录留待其他进程接管。
        """

        self._closing = True
        for loop in self._loops:
            loop.cancel()
        await asyncio.gather(*self._loops, return_exceptions=True)
        self._loops = ()
        while self._tasks:
            for active in tuple(self._active.values()):
                active.token.cancel()
            await asyncio.gather(*tuple(self._tasks), return_exceptions=True)

    # --- 人机往返 -----------------------------------------------------------

    async def abort(self, conversation_id: str, prompt_id: str) -> None:
        """在已授权会话内停止消息：排队或审批直接撤回，活跃运行通过框架取消。"""

        row = await self._queue.abort(prompt_id, conversation_id=conversation_id, now=_now())
        if row.status == "aborted":
            self._publish(row)
            # 审批等待没有活跃 run，撤回后须在此发送终态。
            if row.run_id is not None:
                await self._cancel_awaiting(row)
            return
        active = self._active.get(row.conversation_id)
        if active is not None and active.prompt_id == prompt_id:
            active.token.cancel()

    async def abort_conversation(self, conversation_id: str) -> None:
        """先撤回队列再取消活跃或审批中的消息，避免运行收尾时启动下一条。"""

        for row in await self._queue.abort_queued(conversation_id, now=_now()):
            self._publish(row)
        active = self._active.get(conversation_id)
        if active is not None:
            active.token.cancel()
            return
        # 无活跃 run 时，仍需撤回持久化的审批等待。
        waiting = (await self._queue.view(conversation_id)).active
        if waiting is not None and waiting.status == "awaiting":
            await self.abort(conversation_id, waiting.prompt_id)

    async def steer(self, conversation_id: str, prompt_ids: tuple[str, ...]) -> None:
        """先验证插话，再记录 steered，最后同步递入内容。

        若运行已结束，将消息退回 queued 并显式启动队首；原运行的 start_next 可能已执行。
        """

        active = self._active.get(conversation_id)
        if active is None:
            # 仅在无活跃 run 时查询数据库，以区分审批等待与空闲。
            waiting = (await self._queue.view(conversation_id)).active
            if waiting is not None and waiting.status == "awaiting":
                raise Conflict("这段对话在等审批，插不进去")
            raise Conflict("这段对话现在没有在跑的运行，插不进去")
        picked = await self._queue.pick_for_steer(conversation_id, prompt_ids)
        moved = await self._queue.mark_steered(
            tuple(row.prompt_id for row in picked), run_id=active.run_id, now=_now()
        )
        if self._active.get(conversation_id) is not active:
            await self._revert(tuple(row.prompt_id for row in moved))
            # 原运行已完成 start_next，退回后须再次唤醒队列。
            await self._start_next(conversation_id)
            return
        # _active 可能早于 context 就绪；递入失败时退回队列，避免未消费消息被标记完成。
        undeliverable: list[str] = []
        for row in moved:
            enqueue_id = active.handle.deliver(model_prompt(row.content))
            if enqueue_id is None:
                undeliverable.append(row.prompt_id)
                continue
            active.steered[enqueue_id] = row.prompt_id
            self._publish(row)
        await self._revert(tuple(undeliverable))

    async def _revert(self, prompt_ids: tuple[str, ...]) -> None:
        """将未消费的插话退回队列，由调用方启动下一条。"""

        if not prompt_ids:
            return
        for row in await self._queue.requeue_steered(prompt_ids):
            self._publish(row)

    async def approve(self, conversation_id: str, interaction_id: str, *, approved: bool) -> None:
        """持久化审批决定，齐备后通过 CAS 启动唯一续跑。

        非审批等待或非前沿调用抛 NotFound；重复同值幂等，冲突决定由 record_decision 拒绝。
        """

        row = (await self._queue.view(conversation_id)).active
        if row is None or row.status != "awaiting":
            raise NotFound(f"没有等着回应的审批：{interaction_id}")
        tool_call_id = interaction_id.removeprefix(APPROVAL_ID_PREFIX)
        pending = unanswered_tool_calls(await self._messages(conversation_id))
        if tool_call_id not in pending:
            raise NotFound(f"没有等着回应的审批：{interaction_id}")
        recorded = await self._queue.record_decision(row.prompt_id, tool_call_id, approved=approved)
        self._store.append(
            conversation_id,
            MAIN_AGENT_ID,
            (
                InteractionUpsertOp(
                    interaction=Interaction(
                        interaction_id=interaction_id,
                        interaction_kind="approval",
                        tool_call_id=tool_call_id,
                        state="approved" if approved else "rejected",
                    )
                ),
            ),
        )
        if any(item not in recorded.decisions for item in pending):
            return
        claimed = await self._queue.claim_for_continuation(
            recorded.prompt_id, locked_by=self.locked_by
        )
        if claimed is None:
            return
        self._publish(claimed)
        # 传入更新前的 awaiting 记录，供 _run_once 识别审批续跑。
        self._spawn(recorded)

    async def _cancel_awaiting(self, row: JobRow) -> None:
        """撤回审批等待后，同步结束插话、审批交互、工具卡与轮次；此时没有活跃 run 代为收尾。"""

        if row.run_id is not None:
            for child in await self._queue.settle_steered(row.run_id, status="aborted", now=_now()):
                self._publish(child)
        view = self._store.subscribe_view(row.conversation_id, MAIN_AGENT_ID)
        turn = next((item for item in view.live_turns if item.state == "running"), None)
        waiting = self._store.pending_interactions(row.conversation_id, MAIN_AGENT_ID)
        ops: list[EmittableOperation] = [
            InteractionUpsertOp(interaction=item.model_copy(update={"state": "cancelled"}))
            for item in waiting
        ]
        if turn is not None:
            answered = {item.tool_call_id for item in waiting}
            ops.extend(
                FrameUpsertOp(
                    turn_id=turn.turn_id,
                    step_id=step.step_id,
                    frame=frame.model_copy(update={"state": "error", "error": ORPHAN_TOOL_ERROR}),
                )
                for step in turn.steps
                for frame in step.frames
                if isinstance(frame, ToolFrame) and frame.tool_call_id in answered
            )
            ops.append(
                TurnUpsertOp(
                    turn=TurnHeader.model_validate(
                        turn.model_dump(exclude={"steps"})
                        | {"state": "cancelled", "ended_at": _now().isoformat()}
                    )
                )
            )
        ops.append(MetaMergeOp(meta=TranscriptMeta(activity="idle")))
        self._store.append(row.conversation_id, MAIN_AGENT_ID, tuple(ops))
        if turn is not None and row.run_id is not None:
            await self._hand_over(row.conversation_id, run_id=row.run_id, turn_id=turn.turn_id)
        # 无活跃 run 执行队列交接，须显式启动队首。
        await self._start_next(row.conversation_id)

    async def _start_next(self, conversation_id: str) -> None:
        """启动队首消息；关停期间保留排队记录供清扫接管。"""

        if self._closing:
            return
        following = await self._queue.start_next(conversation_id, locked_by=self.locked_by)
        if following is not None:
            self._publish(following)
            self._spawn(following)

    # --- 跑 -----------------------------------------------------------------

    def _spawn(self, row: JobRow) -> None:
        task = asyncio.create_task(self._drive(row))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _drive(self, row: JobRow) -> None:
        """执行消息并在收尾后启动下一条，包括运行失败的情况。"""

        self._store.pin(row.conversation_id)
        status: JobStatus = "failed"
        try:
            status = await self._run_once(row)
        except Exception:
            _logger.exception("这次运行没跑完", prompt_id=row.prompt_id)
        finally:
            active = self._active.pop(row.conversation_id, None)
            self._store.unpin(row.conversation_id)
            if status == "awaiting":
                # 审批等待不结束轮次或启动下一条；插话保留 steered，由续跑 adopt_steered 接管。
                # 框架在收尾前已 drain asap 消息，审批等待时没有未消费插话。
                pass
            # 关停取消时释放租约供续跑；与用户停止同时发生时，也按此路径处理。
            elif self._closing and status == "aborted":
                await self._release(row, active)
            else:
                await self._settle(active, status=status)
                await self._queue.finish(
                    row.prompt_id,
                    status=status,
                    now=_now(),
                    locked_by=self.locked_by,
                    attempt=row.attempt,
                )
                settled = await self._queue.get(row.prompt_id)
                if settled is not None:
                    self._publish(settled)
                await self._start_next(row.conversation_id)
                # 先启动队首再生成标题，避免附带模型调用阻塞消息队列。
                await self._after_turn(row)

    async def _release(self, row: JobRow, active: _Active | None) -> None:
        """关停时释放租约并保留 running。

        未消费插话退回 queued，已消费插话保留 steered，由后续运行接管。
        """

        await self._revert_stranded(active)
        await self._queue.release(
            row.prompt_id,
            locked_by=self.locked_by,
            reason="服务关停，等待续跑",
            attempt=row.attempt,
        )
        released = await self._queue.get(row.prompt_id)
        if released is not None:
            self._publish(released)

    async def _revert_stranded(self, active: _Active | None) -> None:
        """退回未消费插话，已消费项留待续跑认领。"""

        if active is None:
            return
        stranded = active.handle.undelivered(active.steered)
        if stranded:
            _logger.info("这几条追加没赶上这一轮，退回队列", steers=stranded)
            await self._revert(tuple(active.steered[item] for item in stranded))

    async def _after_turn(self, row: JobRow) -> None:
        """执行轮次完成后的附带动作，异常仅记录。"""

        if self._on_turn_ended is None:
            return
        try:
            await self._on_turn_ended(row)
        except Exception:
            _logger.exception("这一轮的收尾动作没做完", prompt_id=row.prompt_id)

    async def _settle(self, active: _Active | None, *, status: JobStatus) -> None:
        """先将未消费插话退回队列，再更新已消费项的终态。

        用户停止时全部撤回，避免未消费插话立即作为新轮次运行。
        """

        if active is None:
            return
        if status != "aborted":
            stranded = active.handle.undelivered(active.steered)
            if stranded:
                _logger.info("这几条追加没赶上这一轮，退回队列", steers=stranded)
                await self._revert(tuple(active.steered[item] for item in stranded))
        for child in await self._queue.settle_steered(active.run_id, status=status, now=_now()):
            self._publish(child)

    async def _run_once(self, row: JobRow) -> JobStatus:
        """执行单次 run 并返回内部状态。

        首次运行发送用户原文并关闭旧前沿；崩溃续跑直接提交历史，由框架修复或重放未完成调用；
        审批续跑提供覆盖全部前沿调用的决定。两种续跑均不追加用户消息。
        """

        agent = self._agents.get(row.agent_id)
        if agent is None:
            raise NotFound(f"未注册的 agent: {row.agent_id}")

        awaiting = row.status == "awaiting"
        history = await self._messages(row.conversation_id)
        # 轮号按历史合并后的轮次计数，保持实时与历史一致。
        prompt_of_run = await self._queue.prompt_of_runs(row.conversation_id)
        turns = turn_run_ids(history, prompt_of_run)
        # 历史含上次 run 时复用原轮；未留下消息的失败按首次运行处理。
        resumed = (
            None
            if row.run_id is None
            else next((index for index, group in enumerate(turns) if row.run_id in group), None)
        )
        ordinal = len(turns) + 1 if resumed is None else resumed + 1
        turn_id = f"t{ordinal}"
        run_id = f"{row.agent_id}-{uuid.uuid4().hex[:8]}"
        await self._queue.attach_run(
            row.prompt_id, run_id, locked_by=self.locked_by, attempt=row.attempt
        )
        if row.run_id is not None:
            await self._queue.adopt_steered(row.run_id, run_id)

        active = _Active(
            prompt_id=row.prompt_id,
            conversation_id=row.conversation_id,
            run_id=run_id,
            turn_id=turn_id,
            token=CancellationToken(),
            handle=_RunHandle(),
        )
        # 先登记控制句柄，再启动引擎，以接收首事件前的停止和插话。
        self._active[row.conversation_id] = active

        resume_from = (
            None
            if resumed is None
            else (await self._history.read(row.conversation_id)).turns[resumed]
        )
        # 仅崩溃续跑需要修复旧 run，审批续跑已正常结束。
        crashed_run = None if resumed is None or awaiting else row.run_id
        if crashed_run is not None:
            # 框架可能重放前沿调用，先记录未完成副作用供审计。
            unresolved = await self._snapshots.list_unresolved_tool_effects(run_id=crashed_run)
            if unresolved:
                _logger.warning(
                    "续跑前有没收尾的工具副作用",
                    effects=[(r.tool_name, r.tool_call_id, r.idempotency_key) for r in unresolved],
                )
        # 末尾为中断请求时，框架补结果但不发事件，实时投影须同步修复原卡。
        tail = history[-1] if history else None
        repaired = (
            unanswered_tool_calls(history)
            if crashed_run is not None
            and isinstance(tail, ModelRequest)
            and tail.state == "interrupted"
            else ()
        )
        context_window = self._context_limits.get(row.agent_id)
        projector = TranscriptEventStream(
            turn_id=turn_id,
            turn_ordinal=ordinal,
            run_id=run_id,
            content=row.content,
            max_context_tokens=context_window,
            resume_from=resume_from,
            repaired_calls=repaired,
            display=self._display,
        )
        if resume_from is not None:
            # 首批实时操作前写入完整基线，避免同号实时轮次覆盖已有历史步骤。
            self._store.append(
                row.conversation_id,
                MAIN_AGENT_ID,
                _seed_ops(resume_from, last_step_interrupted=not awaiting),
            )

        def report_context(usage: ContextUsage) -> None:
            projector.max_context_tokens = usage.window_tokens
            self._store.append(
                row.conversation_id,
                MAIN_AGENT_ID,
                (
                    MetaMergeOp(
                        meta=TranscriptMeta(
                            agent=agent_context_status(usage.used_tokens, usage.window_tokens)
                        )
                    ),
                ),
            )

        deps = await self._deps_for(row)
        # 审批和崩溃续跑只提交结果或历史，不追加用户消息。
        user_prompt: list[UserContent] | None = None
        deferred_results: DeferredToolResults | None = None
        if awaiting:
            deferred_results = _approvals_of(row, history)
        elif crashed_run is None:
            user_prompt = model_prompt(row.content)
            deferred_results = _close_out(history)
        async with agent.run_stream_events(
            user_prompt,
            message_history=history,
            deferred_tool_results=deferred_results,
            conversation_id=row.conversation_id,
            run_id=run_id,
            deps=deps,
            cancellation_token=active.token,
            capabilities=[
                active.handle,
                # 先压缩再报告用量，仪表反映实际发送的窗口。
                # 未配置窗口时不启用压缩与用量仪表。
                *(
                    [
                        ContextCompaction(
                            strategy=SummarizingCompaction(
                                # 仅满足摘要器构造约束，触发条件由 ContextCompaction 控制。
                                max_messages=1,
                                keep_messages=self._compaction_keep_messages,
                                preserve_first_user_message=False,
                            ),
                            max_tokens=int(context_window * self._compaction_max_fraction),
                            on_compaction=projector.note_compaction,
                        ),
                        ReportContextUsage(on_usage=report_context, context_window=context_window),
                    ]
                    if context_window is not None
                    else []
                ),
            ],
        ) as events:
            async for batch in projector.transform_stream(events):
                self._store.append(row.conversation_id, MAIN_AGENT_ID, batch)

        if projector.deferred is not None:
            return await self._await_approvals(row, run_id=run_id, history=projector.final_history)
        await self._persist_if_unsaved(
            row.conversation_id, run_id=run_id, history=projector.final_history
        )
        await self._hand_over(row.conversation_id, run_id=run_id, turn_id=turn_id)
        if projector.cancelled is not None:
            return "aborted"
        return "failed" if projector.failed else "completed"

    async def _persist_if_unsaved(
        self, conversation_id: str, *, run_id: str, history: Sequence[ModelMessage]
    ) -> None:
        """补存框架未保存的正常运行历史。

        审批与插话并发时可能留下开放调用，StepPersistence 会跳过快照，需显式保存以保留轮次。
        """

        if not history or run_id in await self._derived_run_ids(conversation_id):
            return
        _logger.warning("官方没存下这一轮的快照，运行驱动兜底存一份", run_id=run_id)
        await self._save_history(conversation_id, run_id=run_id, history=history)

    async def _save_history(
        self, conversation_id: str, *, run_id: str, history: Sequence[ModelMessage]
    ) -> None:
        """经 StepStore 协议保存 interrupted 快照，供后续恢复。"""

        await self._snapshots.save_snapshot(
            ContinuableSnapshot(
                run_id=run_id,
                step_index=sum(
                    1
                    for message in history
                    if isinstance(message, ModelResponse) and message.run_id == run_id
                ),
                messages=list(history),
                conversation_id=conversation_id,
                state="interrupted",
            )
        )

    async def _await_approvals(
        self, row: JobRow, *, run_id: str, history: Sequence[ModelMessage]
    ) -> JobStatus:
        """持久化审批历史并将消息转为 awaiting，保留实时轮次与交互。

        框架不保存带开放调用的快照，此处显式保存，续跑时通过 include_interrupted 读取。
        """

        await self._save_history(row.conversation_id, run_id=run_id, history=history)
        waiting = await self._queue.await_approvals(
            row.prompt_id, locked_by=self.locked_by, attempt=row.attempt
        )
        if waiting is not None:
            self._publish(waiting)
        return "awaiting"

    async def _messages(self, conversation_id: str) -> list[ModelMessage]:
        """读取包含中断快照的历史，避免失败轮次丢失与轮号复用；新消息提交前须关闭开放调用。"""

        snapshot = await self._snapshots.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        return [] if snapshot is None else list(snapshot.messages)

    async def _derived_run_ids(self, conversation_id: str) -> tuple[str, ...]:
        """使用 TranscriptHistory 的快照口径计算轮号与交接，包含中断运行。"""

        snapshot = await self._snapshots.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        return () if snapshot is None else tuple(run_ids_from_messages(snapshot.messages))

    async def _hand_over(self, conversation_id: str, *, run_id: str, turn_id: str) -> None:
        """确认历史可重建本轮后释放实时状态；快照尚未落库或保存失败时保留，避免刷新丢失轮次。"""

        if run_id not in await self._derived_run_ids(conversation_id):
            _logger.warning("这一轮还没落进消息历史，先留在实时状态里", run_id=run_id)
            return
        self._store.mark_snapshot_persisted(conversation_id, MAIN_AGENT_ID, turn_id)
        self._store.drop_persisted_turns(conversation_id, MAIN_AGENT_ID)

    def _publish(self, row: JobRow) -> None:
        self._store.append(
            row.conversation_id, MAIN_AGENT_ID, (PromptUpsertOp(prompt=row.as_entity()),)
        )


__all__ = ["ConversationRunner", "ConversationSnapshots", "DepsFor", "TurnEnded"]
