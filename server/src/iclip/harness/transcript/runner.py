"""一次运行的一生：从队列里取一条 prompt，把它跑成一轮，再取下一条。

这里是唯一知道「这段对话此刻有没有在跑」的地方，所以停止、插话、审批三条人机往返也都归它
——那三件事都要够得着**正在跑的那次 run**，而 run 一旦交给引擎，外面就只剩这几个官方口子：

- 停止：``run_stream_events(cancellation_token=...)``。不能拿 ``task.cancel()`` 代替：外部
  取消是 ``BaseException``，进不了官方收尾用的 ``except Exception``，那一轮的终态操作一条都
  发不出去，界面会永远停在「正在跑」。
- 插话：``RunContext.enqueue(priority='asap')``，用一个 capability 在 ``before_run`` 把 ``ctx``
  接住（``_RunHandle``），插话到达时**当场**递进去。官方只有两个 enqueue 入口：``RunContext``
  那个（工具或 capability 钩子里拿得到）和 ``AgentRun.enqueue``（外面驱动 ``agent.iter()`` 时）。
  我们用 ``run_stream_events``，它给的把手有 ``cancel`` 但没有 ``enqueue``；换 ``agent.iter()``
  就得自己按节点驱动图、再把投影器要的那条合并事件流拼出来，而 ``run_stream_events`` 本来就是
  官方给这件事的封装。所以走 capability 这个入口，不是绕路。
  ``event_stream_handler`` 也拿得到 ``ctx``，但它一次运行会被叫好几回（两步的一轮实测四回），
  驱动不了按整轮记状态的投影器。
  不能改成「先攒着、下次模型请求前再递」：官方有两道 drain，第二道在 run 本来要结束时把晚到的
  asap 捞出来做一次 redirect；攒着的话那条消息压根没进官方队列，第二道捞不到它，用户打的字
  静默消失。
  一条追加要么进这次 run，要么退回 ``queued``——收场时清扫一遍没被读到的（见 ``_settle``）。
- 审批：这次 run 以 ``DeferredToolRequests`` 结束，等待记在 prompt 行上（``awaiting``），人点齐
  之后带着决定新起一次 run 接着跑，画进同一轮。不在 run 内 await 人点头——那种等待随进程一起
  消失，而一次审批可能等几天。这一刻的历史由本模块存快照：官方 ``StepPersistence`` 此时不存
  （开放的工具调用过不了它那道门槛），文档写明由调用方持久化。

运行不绑在发起它的那个请求上：请求收下 prompt 就返回，运行在后台任务里跑，产出落进实时状态
供订阅者取。客户端断开只是没人看着。
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
from pydantic_ai_harness.compaction import ContextUsage, ReportContextUsage
from pydantic_ai_harness.step_persistence import ContinuableSnapshot, ToolEffectRecord

from iclip.common.errors import Conflict, NotFound
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
"""一轮跑完之后做点别的（现在是给对话起名字），入参是刚跑完的那条 prompt。

**这一层不知道那是什么。** 引擎不认识对话表，起名字是对话那一侧的事，所以只留一个口子，
接什么由组合根决定。抛出来的异常在这里吞掉：附带动作不该把「这一轮跑完了」拖下水。
"""
"""为一条 prompt 造这次运行的依赖。

身份在**收下 prompt 的那一刻**就定了（行上的 ``ownerUserId``），排在队里等多久都不改。这一层
不认识身份是什么形状，由组合根接。
"""


class ConversationSnapshots(Protocol):
    """按对话取最新存档、写一份存档、查工具副作用的账本。只要这三口，不要整个 step store。

    ``save_snapshot`` 只在 run 停到审批上那一刻用：官方那时不存，我们经它的协议方法写进同一张表，
    续跑那侧照旧用 ``latest_conversation_snapshot`` 原样读回来。
    """

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
    """一条**新**消息进来，而历史前沿还留着上一轮没人回答的开放调用：给它们补一份失败的结果。

    只有发新消息那条路走它（首次跑与原样重跑都算，例如等审批时那一轮被撤销、随后用户又说了一句；
    崩溃续跑压根不发新消息）。不补的话官方拒绝这次运行：
    历史里带着未处理的工具调用时不许再发一句新的用户消息。这是官方留给调用方的口子——那几次调用
    是「前沿」，它等我们说清楚它们到底怎么了（更早的悬空调用官方自己会在每次请求前补齐）。

    **用 ``ToolFailed`` 而不是一句裸字符串。** 裸字符串会被包成 ``ToolReturn``，落进消息里是
    ``outcome='success'``——等于告诉模型这次调用成功了，返回值就是那句话，模型可能照着往下做。
    ``ToolFailed`` 落成 ``outcome='failed'``，而且按官方的说法「让模型看到失败并改道，而不是把同
    一个调用再试一遍」，正是这里要的。

    文字用官方那条常量：官方自己补悬空调用时用的就是它（``_repair_dangling_tool_calls``），同一件
    事在两条路上对模型说同一句话。剩一处对不上——官方那条记的是 ``outcome='interrupted'`` 并盖一个
    「这是补的」标记，而 ``deferred_tool_results`` 表达不了这两样。

    副作用到底发生过没有这里不假设，那件事由官方的工具账本记着（``list_unresolved_tool_effects``）。
    """

    pending = unanswered_tool_calls(history)
    if not pending:
        return None
    return DeferredToolResults(
        calls={item: ToolFailed(INTERRUPTED_TOOL_RETURN_CONTENT) for item in pending}
    )


def _approvals_of(row: JobRow, history: Sequence[ModelMessage]) -> DeferredToolResults:
    """人点过的那些决定，摆成官方续跑要的形状。

    官方要求给出的结果覆盖前沿**全部**可执行调用，少一个直接拒绝这次运行。所以只在凑齐之后才
    起续跑（见 ``approve``），走到这里还缺就是程序错，当场抛出来而不是拿一个空决定去糊过去。
    """

    pending = unanswered_tool_calls(history)
    missing = [item for item in pending if item not in row.decisions]
    if missing:
        raise RuntimeError(f"这几次调用还没有审批结果，续跑起不来：{missing}")
    return DeferredToolResults(approvals={item: row.decisions[item] for item in pending})


def _seed_ops(
    turn: TranscriptTurn, *, last_step_interrupted: bool
) -> tuple[EmittableOperation, ...]:
    """把历史推出来的这一轮原样写进实时状态：轮头部、每一步、每一块。

    顺序不能改：实时状态落地时步要挂在已有的轮上、块要挂在已有的步上，反了直接抛 ``KeyError``，
    整批操作连带轮头部一起丢掉。

    ``last_step_interrupted`` 是「老 run 断在末步」：中断续跑是这样，审批续跑不是——那一步是干净
    结束的，标成中断的话刷新时它会从「完成」翻成「中断」。
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
            # 老 run 停在这一步。历史那侧要等续跑的消息落库才看得出这件事（见 ``from_messages``
            # 里的 ``broke_off``），这侧现在就知道，不标的话刷新时这一步会从「完成」翻成「中断」。
            header = header.model_copy(update={"state": "interrupted"})
        ops.append(StepUpsertOp(turn_id=turn.turn_id, step=header))
        ops.extend(
            FrameUpsertOp(turn_id=turn.turn_id, step_id=step.step_id, frame=frame)
            for frame in step.frames
        )
    return tuple(ops)


@dataclass
class _RunHandle(AbstractCapability[Any]):
    """把这次 run 的 ``ctx`` 接出来，好让外面直接往官方队列里递内容。

    ``ctx`` 每个图节点会重建，但 ``pending_messages`` 是 run 级的同一个 list（官方在
    ``build_run_context`` 上标了不可 ``replace`` 的那几项），所以接住第一个就够用一整轮。
    """

    ctx: RunContext[Any] | None = None

    async def before_run(self, ctx: RunContext[Any]) -> None:
        self.ctx = ctx

    def deliver(self, content: list[UserContent]) -> str | None:
        """把一条追加递进这次 run，返回官方给的入队 id；run 还没起来就返回 ``None``。

        整条一起递——拆开会让图和它那句话分家。
        """

        if self.ctx is None:
            return None
        return self.ctx.enqueue(*content, priority="asap")

    def undelivered(self, enqueue_ids: Iterable[str]) -> tuple[str, ...]:
        """这些入队 id 里，哪些还躺在官方队列里没被读走。"""

        if self.ctx is None or self.ctx.pending_messages is None:
            return tuple(enqueue_ids)
        waiting = {message.enqueue_id for message in self.ctx.pending_messages}
        return tuple(item for item in enqueue_ids if item in waiting)


@dataclass(slots=True)
class _Active:
    """正在跑的那一轮，加上够得着它的那几个把手。"""

    prompt_id: str
    conversation_id: str
    run_id: str
    turn_id: str
    token: CancellationToken
    handle: _RunHandle
    steered: dict[str, str] = field(default_factory=dict[str, str])
    """递进这一轮的追加：官方给的入队 id → 那条 prompt 的 id。收场时按它清扫。"""


class ConversationRunner:
    """按对话跑 prompt：一次一条，跑完接上下一条。"""

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
        # 收的是那个类而不是一个窄协议：只要 read 的协议照样得从 history 模块取回它的返回类型，
        # 模块依赖躲不掉，而那个类本身已经是两口存储之上的一层薄壳，没有别的依赖可挡。
        self._history = history
        self._deps_for = deps_for
        self._context_limits = context_limits
        self._heartbeat_seconds = heartbeat_seconds
        self._lease_seconds = lease_seconds
        self._sweep_seconds = sweep_seconds
        self._max_attempts = max_attempts
        self._compaction_max_fraction = compaction_max_fraction
        self._compaction_keep_messages = compaction_keep_messages
        # 工具卡的画法。历史那一侧（``TranscriptHistory``）必须收到同一份实例：两边不一样的话，
        # 同一张卡在刷新前后换个长相，而且不报错。
        self._display = display
        # 这个进程的租约主人。收下 prompt 的那一侧也要拿它写行，所以公开。
        self.locked_by = locked_by or uuid.uuid4().hex
        self._on_turn_ended = on_turn_ended
        self._active: dict[str, _Active] = {}
        self._closing = False
        # 拿住任务的引用：asyncio 只弱引用运行中的任务，不存着的话跑一半可能被回收掉。
        self._tasks: set[asyncio.Task[None]] = set()
        # 两个后台循环单独存：关停时先停它们，而 ``_tasks`` 装的是在跑的那些轮子。
        self._loops: tuple[asyncio.Task[None], ...] = ()

    # --- 收下与排程 ---------------------------------------------------------

    async def submit(self, row: JobRow) -> JobRow:
        """把队列已经收下的一条 prompt 广播出去；轮到它就地起 run。"""

        self._publish(row)
        if row.status == "running":
            self._spawn(row)
        return row

    async def start(self) -> None:
        """先清扫一次，再起心跳与清扫两个循环。"""

        await self.sweep_once()
        self._loops = (
            asyncio.create_task(self._loop(self._heartbeat_seconds, self.heartbeat_once)),
            asyncio.create_task(self._loop(self._sweep_seconds, self.sweep_once)),
        )

    async def heartbeat_once(self) -> None:
        """给手上在跑的那些行刷一次心跳；刷不到的那一轮就地按第一方取消停掉。

        刷不到只有一种意思：那行已经不归自己了（租约被判过期、或者已经被别人接手）。留着跑下去
        的话，同一段对话会有两个进程在跑，而落库的结局归接手那一方。
        """

        alive = set(await self._queue.heartbeat(locked_by=self.locked_by))
        for active in tuple(self._active.values()):
            if active.prompt_id in alive:
                continue
            _logger.warning("这一轮的租约已经不在手上，取消它", prompt_id=active.prompt_id)
            active.token.cancel()

    async def sweep_once(self) -> None:
        """收拾中断的行：认领次数用完的判失败，还有机会的认领下来续跑，再把没人管的队列叫醒。

        关停途中只做判失败那一步：认领与叫醒都会起新运行，而它只会立刻被取消，反而给用户留一条
        从没跑过、却记着「撤销了」的消息。
        """

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
        """每隔 ``seconds`` 秒做一次那件事，出错只记一笔接着转。

        循环停了就等于自己的租约停了续，手上在跑的那些会被别人接管：认领次数还有剩的被别人续跑，
        用完的判失败。
        """

        while True:
            await asyncio.sleep(seconds)
            try:
                await once()
            except Exception:
                _logger.exception("后台循环这一轮没做完")

    async def shutdown(self) -> None:
        """关停：先停两个后台循环，再把在跑的都按第一方取消停掉，等它们各自收完尾。

        不用 ``task.cancel()`` 收运行——那是外部取消，官方的收尾分支接不住，终态操作发不出去。

        先立牌子再取消：立了之后收尾的那一步不再去队列里接下一条，于是排着的那些原样留在库里，
        由别的进程清扫时叫醒。不立的话，关停途中会起一次新运行，然后立刻把它取消掉——用户会看到
        一条自己从没跑过、却记着「撤销了」的消息。
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
        """停掉一条 prompt。排队的直接标掉，在跑的发第一方取消。

        ``conversation_id`` 是调用方已经核过权的那一段。这条 prompt 不属于它就当作没有——
        消息 id 是客户端铸的，光凭一个 id 就能停掉别人的运行。
        """

        row = await self._queue.abort(prompt_id, conversation_id=conversation_id, now=_now())
        if row.status == "aborted":
            self._publish(row)
            # 撤掉的是那条等审批的（排着的从来没起过 run，``run_id`` 是空的）：那一轮没有 run
            # 在跑，没人替它发终态，得在这里收拾。
            if row.run_id is not None:
                await self._cancel_awaiting(row)
            return
        active = self._active.get(row.conversation_id)
        if active is not None and active.prompt_id == prompt_id:
            active.token.cancel()

    async def abort_conversation(self, conversation_id: str) -> None:
        """停掉整段对话：排着的全撤，在跑的那条发第一方取消，等审批的那条当场撤掉。

        顺序不能反：先取消在跑的那条，它收尾时会把队首顶上来接着跑——用户按了停止，反而看到下
        一条开跑。先把队列撤空，收尾时就没有可接的了。
        """

        for row in await self._queue.abort_queued(conversation_id, now=_now()):
            self._publish(row)
        active = self._active.get(conversation_id)
        if active is not None:
            active.token.cancel()
            return
        # 没有 run 在跑，但这段对话可能正停在审批上——那条行也归「停掉整段对话」管。
        waiting = (await self._queue.view(conversation_id)).active
        if waiting is not None and waiting.status == "awaiting":
            await self.abort(conversation_id, waiting.prompt_id)

    async def steer(self, conversation_id: str, prompt_ids: tuple[str, ...]) -> None:
        """把排队中的几条插进正在跑的那一轮。

        顺序是这条方法的全部要点：挑出来 → 改状态 → 递内容。递内容那一步不 ``await``，所以「递进
        去了但状态没记上」这个中间态不存在；反过来写的话那一轮要是刚好收场，收场清扫看到的还是
        ``queued``，什么都不会退回，随后状态被钉成一个属于死运行的 ``steered``。

        改完状态到递内容之间那一轮也可能已经收场（``_active`` 被摘掉）。这时把它退回队列并自己
        叫一次下一条：收场那一侧的 ``start_next`` 已经跑过了，不叫的话这条会一直排着没人管。
        """

        active = self._active.get(conversation_id)
        if active is None:
            # 只在没有 run 在跑时才去问库：等审批与真的空闲对用户是两回事，而这一问在正常路径
            # 上是多余的往返。
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
            # 收场那一侧的 start_next 已经跑过了，这里不叫的话这几条会一直排着没人管。
            await self._start_next(conversation_id)
            return
        # ``_active`` 在进引擎之前就挂上了（停止和插话随时可能先到），所以这几微秒里 ``ctx`` 还
        # 可能没接住。递不进去的原样退回队列——记成 ``steered`` 而没人递，它会跟着这一轮报成完成，
        # 而模型从没见过这句话。
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
        """把没被那一轮读到的追加退回队列。叫下一条是调用方的事。"""

        if not prompt_ids:
            return
        for row in await self._queue.requeue_steered(prompt_ids):
            self._publish(row)

    async def approve(self, conversation_id: str, interaction_id: str, *, approved: bool) -> None:
        """人对一张审批卡点了「同意」或「拒绝」。决定记在 prompt 行上，凑齐了才起续跑。

        这段对话没在等审批、或者那张卡不在前沿的开放调用里，抛 ``NotFound``——那个 id 是从帧里
        抄来的，指着一次早就有结果的调用时不能假装刚刚记下了什么。同值重复提交照原样收下，改主意
        抛 ``Conflict``（``record_decision`` 那道判断）。

        起续跑的 CAS 只有一个人能成：两次点击、或者两个 worker 同时凑齐时，抢不到的那一方什么都
        不做。
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
        # 递 ``awaiting`` 那一份：库里那行已经改成在跑，而 ``_run_once`` 要靠行上的状态认出
        # 「这次是审批续跑」。
        self._spawn(recorded)

    async def _cancel_awaiting(self, row: JobRow) -> None:
        """一条等审批的 prompt 被撤掉之后收尾：递进去的插话、实时状态里的审批卡与那一轮，然后放手。

        这一轮没有 run 在跑，没人替它发终态。不发的话界面上留着一张永远等回应的卡、一张一直转
        圈的工具卡，侧栏也一直显示这段对话在忙；而递进那次 run 的插话本来等着续跑给结局，续跑
        不会再来了，它们得跟着这一轮一起撤销。
        """

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
        # 这一轮没有 run 在跑，没人替它去接队首——不叫的话排着的那些会一直等到下一次清扫。
        await self._start_next(row.conversation_id)

    async def _start_next(self, conversation_id: str) -> None:
        """把这段对话排在最前的那条顶上来开跑。

        关停途中不接：接了也只会立刻被取消，反而给用户留一条从没跑过、却记着「撤销了」的消息。
        排着的那些原样留在库里，由清扫叫醒。
        """

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
        """跑完这一条，然后接上队列里的下一条。

        跑出什么错都要走到接下一条那一步：漏掉的话这段对话会卡在一条已经结束的 prompt 后面，
        而队列里排着的那些永远等不到人叫。
        """

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
                # 停在审批上：这一轮没结束，不给结局、不交接实时状态、也不接下一条。递进去的
                # 插话全都留在 ``steered``，由续跑那次 run 认走（``adopt_steered``）——这里没有
                # 「没被读到」的：官方在 run 收场前一定先把 asap 消息捞成一次新请求（见模块开头
                # 「第二道 drain」），所以能停在审批上的 run 手里不会有没读的插话。
                pass
            # 关停时被取消收场的那一轮不给结局，放掉租约等人接着跑。用户按的停止走的也是取消，
            # 与关停撞在一起时这条会跟着被续跑一次。
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
                # 放在接下一条之后：起名字要等一次模型调用，排在前面的话队列里那条就得干等它。
                await self._after_turn(row)

    async def _release(self, row: JobRow, active: _Active | None) -> None:
        """关停时放掉这一轮：行留在 ``running``，由清扫重新认领、从最新快照续跑。

        不给结局也不撤销——进度已经由官方快照落库了，下一条命接着往下跑。没被这次 run 读到的
        追加退回队列，读到的留在 ``steered``：续跑那次 run 会认走它们（``adopt_steered``），结局
        跟着续跑那一次。
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
        """把这次 run 没读到的追加退回队列。读走的留在 ``steered``，由续跑那次 run 认走。"""

        if active is None:
            return
        stranded = active.handle.undelivered(active.steered)
        if stranded:
            _logger.info("这几条追加没赶上这一轮，退回队列", steers=stranded)
            await self._revert(tuple(active.steered[item] for item in stranded))

    async def _after_turn(self, row: JobRow) -> None:
        """一轮的附带动作。出什么错都只记一笔：这一轮本身已经跑完并落了终态。"""

        if self._on_turn_ended is None:
            return
        try:
            await self._on_turn_ended(row)
        except Exception:
            _logger.exception("这一轮的收尾动作没做完", prompt_id=row.prompt_id)

    async def _settle(self, active: _Active | None, *, status: JobStatus) -> None:
        """给递进这一轮的那几条追加定结局。

        没被读到的先退回队列、再给读到的定结局，顺序不能反：反了的话没读到的那几条会先跟着这一轮
        记成完成，用户打的字就成了一条「跑过了」却从没进过模型的记录。官方在 run 本来要结束时会把
        晚到的 asap 捞出来做一次 redirect，所以走到这里还留在官方队列里的，是连那一道都没赶上的。

        **用户按了停止（``aborted``）时不退回**：退回等于紧接着把它当新的一轮开跑，而用户刚说的
        是别跑了。这时没赶上的那几条跟着这一轮一起撤销。
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
        """跑一次 run，返回这一轮此刻的内部状态。

        三条起手。**首次跑**（含崩在第一个周期之前的原样重跑）：发用户那句原话，历史前沿还留着
        没人回答的开放调用时先收掉（见 ``_close_out``）。**崩溃续跑**（老 run 的消息在历史里）：
        一句新的用户消息都不发、也不给结果，历史原样交给官方，它按末尾的形状接着跑——完整的请求
        原样重发、标着中断的请求补上没有返回的那几次调用、带调用的响应把那些调用重新执行一遍。
        **审批续跑**（行上记着 ``awaiting``）：带着人点的决定，官方要求这份结果覆盖前沿全部可执行
        调用，已经执行过的那几次它自己按末尾那条请求里的返回标成跳过。
        """

        agent = self._agents.get(row.agent_id)
        if agent is None:
            raise NotFound(f"未注册的 agent: {row.agent_id}")

        awaiting = row.status == "awaiting"
        history = await self._messages(row.conversation_id)
        # 轮号接着历史往下数。两条路必须给出同一个号，而历史那侧数的是合成轮之后的组数。
        prompt_of_run = await self._queue.prompt_of_runs(row.conversation_id)
        turns = turn_run_ids(history, prompt_of_run)
        # 上一次 run 的消息已经落库：这次是续跑，画进它原来那一轮，不占新号。落不下消息就崩了的
        # （历史里找不着它），按原样重跑一次，轮号照常数。
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
        # 先挂上再开跑：停止和插话随时可能在第一个事件之前就到。
        self._active[row.conversation_id] = active

        resume_from = (
            None
            if resumed is None
            else (await self._history.read(row.conversation_id)).turns[resumed]
        )
        # 崩溃续跑要接着跑的那次老 run。审批续跑不算：那一轮是干净停在审批上的。
        crashed_run = None if resumed is None or awaiting else row.run_id
        if crashed_run is not None:
            # 官方接着跑会重新执行前沿那几次调用，所以停在「开始了」的副作用先记一笔，事后查得到。
            unresolved = await self._snapshots.list_unresolved_tool_effects(run_id=crashed_run)
            if unresolved:
                _logger.warning(
                    "续跑前有没收尾的工具副作用",
                    effects=[(r.tool_name, r.tool_call_id, r.idempotency_key) for r in unresolved],
                )
        # 只有「末尾是标着中断的请求」这一形状官方是补返回而不发事件，实时那侧得自己把卡收掉；
        # 另两种形状要么没有开放调用，要么那些调用被重新执行，事件照常到达。
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
            content=row.content,
            max_context_tokens=context_window,
            resume_from=resume_from,
            repaired_calls=repaired,
            display=self._display,
        )
        if resume_from is not None:
            # 播种要在投影器发第一批之前落地：同号的轮以实时那份为准，只有新步的实时轮会把历史
            # 里已经跑过的那几步整个盖掉。
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
        # 两条续跑都不发新的用户消息：审批续跑里模型收到的是那几次调用的结果，崩溃续跑里历史本身
        # 就是要接着跑的东西——多说一句话会让模型把它当成用户新提的要求。
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
                *(
                    [ReportContextUsage(on_usage=report_context, context_window=context_window)]
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
        """run 正常收场而官方没存下它的快照时，由这里兜底存一份，这一轮不会从历史里消失。

        官方 ``StepPersistence`` 只存「每个工具调用都有返回」的历史。一次 run 收场时末尾留着悬空
        调用（模型发起了要审批的调用，插话却在同一刻递进来，官方把插话捞成新请求、审批被跳过），
        它一份都不存；下一次运行拿不到这一轮，轮号被重用，这一轮从此看不见。
        """

        if not history or run_id in await self._derived_run_ids(conversation_id):
            return
        _logger.warning("官方没存下这一轮的快照，运行驱动兜底存一份", run_id=run_id)
        await self._save_history(conversation_id, run_id=run_id, history=history)

    async def _save_history(
        self, conversation_id: str, *, run_id: str, history: Sequence[ModelMessage]
    ) -> None:
        """经官方 ``StepStore`` 协议存一份 ``interrupted`` 快照，续跑那侧照旧读得回。"""

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
        """这次 run 停在审批上：存下此刻的历史，行改成等审批，实时那一轮原样留着。

        快照由我们存：官方 ``StepPersistence`` 在这一刻不存（开放的工具调用过不了它那道门槛），
        文档写明由调用方持久化。走它的协议方法写进同一张表，续跑那侧照旧用
        ``latest_conversation_snapshot(include_interrupted=True)`` 原样读回来。

        实时那一轮不交接：轮还在 running、审批卡还等着回应。
        """

        await self._save_history(row.conversation_id, run_id=run_id, history=history)
        waiting = await self._queue.await_approvals(
            row.prompt_id, locked_by=self.locked_by, attempt=row.attempt
        )
        if waiting is not None:
            self._publish(waiting)
        return "awaiting"

    async def _messages(self, conversation_id: str) -> list[ModelMessage]:
        """这段对话到目前为止的消息，中断的那一份也算。

        只读完整的快照会让一次失败的运行从此消失：它只落得下中断的那一份，下一次运行拿不到它，
        于是它也不进后面任何一份快照——轮号被重用，历史里那一轮再也找不回来。

        代价是历史末尾可能留着没有结果的工具调用，起 run 时得把它们收掉（见
        ``unanswered_tool_calls``）。
        """

        snapshot = await self._snapshots.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        return [] if snapshot is None else list(snapshot.messages)

    async def _derived_run_ids(self, conversation_id: str) -> tuple[str, ...]:
        """历史那一侧推得出来的运行，中断的也算。

        轮号与交接都按这一份，不按 ``_history``：两者选的快照不一样的话，一次失败的运行会让轮号
        重用——历史那侧把它算进去了，这侧没有，于是新一轮和失败那一轮同号，界面上两个 t5。
        """

        snapshot = await self._snapshots.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        return () if snapshot is None else tuple(run_ids_from_messages(snapshot.messages))

    async def _hand_over(self, conversation_id: str, *, run_id: str, turn_id: str) -> None:
        """确认这一轮已经落进消息历史，再把它从实时状态里放掉。

        先确认再放手：终态操作发出去之后快照才在写，中间要是先丢了，两边都拿不出这一轮，
        客户端刷新会看到它凭空消失。落库失败就一直留着，占点内存换不丢。

        按历史那一侧能推出什么来判，含中断的快照：一次失败的运行只落得下中断的那一份，按完整的
        判就永远交接不掉，这一轮会一直占着实时状态。
        """

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
