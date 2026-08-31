"""一次运行的一生：从队列里取一条 prompt，把它跑成一轮，再取下一条。

这里是唯一知道「这段对话此刻有没有在跑」的地方，所以停止、插话、审批三条人机往返也都归它
——那三件事都要够得着**正在跑的那次 run**，而 run 一旦交给引擎，外面就只剩这几个官方口子：

- 停止：``run_stream_events(cancellation_token=...)``。不能拿 ``task.cancel()`` 代替：外部
  取消是 ``BaseException``，进不了官方收尾用的 ``except Exception``，那一轮的终态操作一条都
  发不出去，界面会永远停在「正在跑」。
- 插话：``RunContext.enqueue(priority='asap')``，只有在 run 里面（工具、capability 钩子）才
  拿得到 ``ctx``，所以做成一个 capability（``_SteerInbox``）。
- 审批：``HandleDeferredToolCalls`` 的 handler 可以是 async，在**同一次 run 内**等人点头，
  所以一轮不会被劈成两次 run。

运行不绑在发起它的那个请求上：请求收下 prompt 就返回，运行在后台任务里跑，产出落进实时状态
供订阅者取。客户端断开只是没人看着。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic_ai import Agent, CancellationToken
from pydantic_ai.capabilities import AbstractCapability, HandleDeferredToolCalls
from pydantic_ai.messages import ModelMessage, UserContent
from pydantic_ai.models import ModelRequestContext
from pydantic_ai.tools import DeferredToolRequests, DeferredToolResults, RunContext
from pydantic_ai_harness.step_persistence import ContinuableSnapshot

from iclip.common.errors import Conflict, NotFound
from iclip.harness.prompts import PromptQueue, PromptRow, PromptStatus
from iclip.harness.transcript.from_messages import run_ids_from_messages
from iclip.harness.transcript.projector import TranscriptEventStream
from iclip.harness.transcript.prompt_media import attachments_of, model_prompt
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.ops import (
    MAIN_AGENT_ID,
    AttachmentUpsertOp,
    Interaction,
    InteractionUpsertOp,
    PromptUpsertOp,
)

_logger = logging.getLogger(__name__)

DepsFor = Callable[[PromptRow], Awaitable[Any]]
"""为一条 prompt 造这次运行的依赖。

身份在**收下 prompt 的那一刻**就定了（行上的 ``ownerUserId``），排在队里等多久都不改。这一层
不认识身份是什么形状，由组合根接。
"""


class ConversationSnapshots(Protocol):
    """按对话取最新存档。只要这一口，不要整个 step store。"""

    async def latest_conversation_snapshot(
        self, *, conversation_id: str
    ) -> ContinuableSnapshot | None: ...  # pragma: no cover


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass
class _SteerInbox(AbstractCapability[Any]):
    """插话的收件箱：外面放进来，run 里面在下一次模型请求前递进去。"""

    pending: list[list[UserContent]] = field(default_factory=list["list[UserContent]"])
    """每条插话是一串（文字加附件），整条一起递进去——拆开会让图和它那句话分家。"""

    async def before_model_request(
        self, ctx: RunContext[Any], request_context: ModelRequestContext
    ) -> ModelRequestContext:
        while self.pending:
            ctx.enqueue(*self.pending.pop(0), priority="asap")
        return request_context


@dataclass
class _ApprovalDesk:
    """等人点头。每个待批的工具调用一个位子，人回话了就把它填上。"""

    decisions: dict[str, asyncio.Future[bool]] = field(
        default_factory=dict[str, "asyncio.Future[bool]"]
    )

    async def handle(
        self, _ctx: RunContext[Any], requests: DeferredToolRequests
    ) -> DeferredToolResults:
        """等齐这一批的全部回话，再把结果交回引擎。

        这里**不能吞 ``CancelledError``**：停止就是靠取消送达的，吞掉的话这次 run 会一直挂在
        等人回话上，谁也停不了它。
        """

        loop = asyncio.get_running_loop()
        for part in requests.approvals:
            self.decisions.setdefault(part.tool_call_id, loop.create_future())
        results = DeferredToolResults()
        for part in requests.approvals:
            results.approvals[part.tool_call_id] = await self.decisions[part.tool_call_id]
        return results

    def settle(self, tool_call_id: str, *, approved: bool) -> bool:
        """人点了。这个位子还没人填过才算数，返回是否真的填上了。"""

        waiting = self.decisions.get(tool_call_id)
        if waiting is None or waiting.done():
            return False
        waiting.set_result(approved)
        return True


@dataclass(slots=True)
class _Active:
    """正在跑的那一轮，加上够得着它的那几个把手。"""

    prompt_id: str
    conversation_id: str
    run_id: str
    turn_id: str
    token: CancellationToken
    inbox: _SteerInbox
    desk: _ApprovalDesk


class ConversationRunner:
    """按对话跑 prompt：一次一条，跑完接上下一条。"""

    def __init__(
        self,
        *,
        agents: dict[str, Agent[Any, Any]],
        store: TranscriptStore,
        queue: PromptQueue,
        snapshots: ConversationSnapshots,
        deps_for: DepsFor,
    ) -> None:
        self._agents = agents
        self._store = store
        self._queue = queue
        self._snapshots = snapshots
        self._deps_for = deps_for
        self._active: dict[str, _Active] = {}
        self._closing = False
        # 拿住任务的引用：asyncio 只弱引用运行中的任务，不存着的话跑一半可能被回收掉。
        self._tasks: set[asyncio.Task[None]] = set()

    # --- 收下与排程 ---------------------------------------------------------

    async def submit(self, row: PromptRow) -> PromptRow:
        """把队列已经收下的一条 prompt 广播出去；轮到它就地起 run。"""

        self._publish(row)
        if row.status == "running":
            self._spawn(row)
        return row

    async def sweep(self) -> int:
        """启动时收拾上一条命留下的行，返回收拾了几条。"""

        return await self._queue.discard_stale(now=_now())

    async def shutdown(self) -> None:
        """关停：把在跑的都按第一方取消停掉，等它们各自收完尾。

        不用 ``task.cancel()``——那是外部取消，官方的收尾分支接不住，终态操作发不出去。

        先立牌子再取消：立了之后收尾的那一步不再去队列里接下一条，于是排着的那些原样留在库里，
        下次启动时由 ``sweep`` 统一处置。不立的话，关停途中会起一次新运行，然后立刻把它取消掉
        ——用户会看到一条自己从没跑过、却记着「撤销了」的消息。
        """

        self._closing = True
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

        row = await self._queue.abort(prompt_id, now=_now())
        if row.conversation_id != conversation_id:
            raise NotFound(f"没有这条消息：{prompt_id}")
        if row.status == "queued":
            settled = await self._queue.get(prompt_id)
            if settled is not None:
                self._publish(settled)
            return
        active = self._active.get(row.conversation_id)
        if active is not None and active.prompt_id == prompt_id:
            active.token.cancel()

    async def abort_conversation(self, conversation_id: str) -> None:
        """停掉整段对话：排着的全撤，在跑的那条发第一方取消。

        顺序不能反：先取消在跑的那条，它收尾时会把队首顶上来接着跑——用户按了停止，反而看到下
        一条开跑。先把队列撤空，收尾时就没有可接的了。
        """

        for row in await self._queue.abort_queued(conversation_id, now=_now()):
            self._publish(row)
        active = self._active.get(conversation_id)
        if active is not None:
            active.token.cancel()

    async def steer(self, conversation_id: str, prompt_ids: tuple[str, ...]) -> None:
        """把排队中的几条插进正在跑的那一轮。"""

        active = self._active.get(conversation_id)
        if active is None:
            raise Conflict("这段对话现在没有在跑的运行，插不进去")
        for row in await self._queue.steer(conversation_id, prompt_ids, now=_now()):
            active.inbox.pending.append(model_prompt(row.content))
            settled = await self._queue.get(row.prompt_id)
            if settled is not None:
                self._publish(settled)

    def approve(self, conversation_id: str, interaction_id: str, *, approved: bool) -> None:
        """人对一张审批卡点了「同意」或「拒绝」。

        没有这张卡、或者它已经落定过，抛 ``NotFound``：重复提交同一个决定不该悄悄换掉第一次
        的结果，而工具那一侧早就照第一次的决定走下去了。
        """

        active = self._active.get(conversation_id)
        tool_call_id = interaction_id.removeprefix("apr_")
        if active is None or not active.desk.settle(tool_call_id, approved=approved):
            raise NotFound(f"没有等着回应的审批：{interaction_id}")
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

    # --- 跑 -----------------------------------------------------------------

    def _spawn(self, row: PromptRow) -> None:
        task = asyncio.create_task(self._drive(row))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _drive(self, row: PromptRow) -> None:
        """跑完这一条，然后接上队列里的下一条。

        跑出什么错都要走到接下一条那一步：漏掉的话这段对话会卡在一条已经结束的 prompt 后面，
        而队列里排着的那些永远等不到人叫。
        """

        self._store.pin(row.conversation_id)
        status: PromptStatus = "failed"
        try:
            status = await self._run_once(row)
        except Exception:
            _logger.exception("这次运行没跑完：prompt=%s", row.prompt_id)
        finally:
            self._active.pop(row.conversation_id, None)
            self._store.unpin(row.conversation_id)
            await self._queue.finish(row.prompt_id, status=status, now=_now())
            settled = await self._queue.get(row.prompt_id)
            if settled is not None:
                self._publish(settled)
            # 关停途中不再往下接：接了也只会立刻被取消，反而给用户留一条从没跑过、却记着
            # 「撤销了」的消息。排着的那些原样留在库里，下次启动由 sweep 处置。
            if not self._closing:
                following = await self._queue.start_next(row.conversation_id)
                if following is not None:
                    self._publish(following)
                    self._spawn(following)

    async def _run_once(self, row: PromptRow) -> PromptStatus:
        agent = self._agents.get(row.agent_id)
        if agent is None:
            raise NotFound(f"未注册的 agent: {row.agent_id}")

        history = await self._history(row.conversation_id)
        # 轮号接着历史往下数。两条路必须给出同一个号，而历史那侧数的就是消息里的 run 分组。
        ordinal = len(run_ids_from_messages(history)) + 1
        turn_id = f"t{ordinal}"
        run_id = f"{row.agent_id}-{uuid.uuid4().hex[:8]}"
        await self._queue.attach_run(row.prompt_id, run_id)

        active = _Active(
            prompt_id=row.prompt_id,
            conversation_id=row.conversation_id,
            run_id=run_id,
            turn_id=turn_id,
            token=CancellationToken(),
            inbox=_SteerInbox(),
            desk=_ApprovalDesk(),
        )
        # 先挂上再开跑：停止和插话随时可能在第一个事件之前就到。
        self._active[row.conversation_id] = active

        # 附件先落进实时状态：轮头部只带 id，实体本身在快照里，订阅者要能同时拿到两样。
        attachments = attachments_of(row.content)
        if attachments:
            self._store.append(
                row.conversation_id,
                MAIN_AGENT_ID,
                tuple(AttachmentUpsertOp(attachment=item) for item in attachments),
            )
        projector = TranscriptEventStream(
            turn_id=turn_id,
            turn_ordinal=ordinal,
            prompt=row.text,
            attachment_ids=tuple(item.attachment_id for item in attachments),
        )
        deps = await self._deps_for(row)
        async with agent.run_stream_events(
            model_prompt(row.content),
            message_history=history,
            conversation_id=row.conversation_id,
            run_id=run_id,
            deps=deps,
            cancellation_token=active.token,
            capabilities=[
                active.inbox,
                HandleDeferredToolCalls(handler=active.desk.handle),
            ],
        ) as events:
            async for batch in projector.transform_stream(events):
                self._store.append(row.conversation_id, MAIN_AGENT_ID, batch)

        await self._hand_over(row.conversation_id, run_id=run_id, turn_id=turn_id)
        if projector.cancelled is not None:
            return "aborted"
        return "failed" if projector.failed else "completed"

    async def _history(self, conversation_id: str) -> list[ModelMessage]:
        snapshot = await self._snapshots.latest_conversation_snapshot(
            conversation_id=conversation_id
        )
        return [] if snapshot is None else list(snapshot.messages)

    async def _hand_over(self, conversation_id: str, *, run_id: str, turn_id: str) -> None:
        """确认这一轮已经落进消息历史，再把它从实时状态里放掉。

        先确认再放手：终态操作发出去之后快照才在写，中间要是先丢了，两边都拿不出这一轮，
        客户端刷新会看到它凭空消失。落库失败就一直留着，占点内存换不丢。
        """

        if run_id not in run_ids_from_messages(await self._history(conversation_id)):
            _logger.warning("这一轮还没落进消息历史，先留在实时状态里：run=%s", run_id)
            return
        self._store.mark_snapshot_persisted(conversation_id, MAIN_AGENT_ID, turn_id)
        self._store.drop_persisted_turns(conversation_id, MAIN_AGENT_ID)

    def _publish(self, row: PromptRow) -> None:
        self._store.append(
            row.conversation_id, MAIN_AGENT_ID, (PromptUpsertOp(prompt=row.as_entity()),)
        )


__all__ = ["ConversationRunner", "ConversationSnapshots", "DepsFor"]
