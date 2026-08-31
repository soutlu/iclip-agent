"""transcript 的对外面：六个 REST 端点加一条 WebSocket。

本文件只认识 starlette/fastapi、协议形状，与一个注入进来的入口。引擎侧类型在围栏另一侧，从
这里结构上就 import 不到——HTTP 与 agent 引擎的分离是机械的，不靠自觉。

**WS 必须自己校验 ``Origin``。** 升级请求不受 CORS 约束，浏览器会照常带上 cookie，所以任何
网页都能替已登录的用户开一条连接。这条校验是 ``POST /agents/{id}/chat`` 上那对 CSRF 防线
（强制预检 + 不放行预检）在 WS 上的等价物，去掉它等于把那道门重新拆了。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Protocol

from fastapi import APIRouter, Depends, Path, Query, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from iclip.common.errors import DomainError
from iclip.domains.identity.public import (
    Principal,
    require_permission,
    websocket_origin_allowed,
    websocket_principal,
)
from iclip.platform.transcript.ops import MAIN_AGENT_ID, Prompt, PromptContent
from iclip.platform.transcript.wire import (
    Ack,
    ApprovalRequest,
    ClientFrame,
    ClientHello,
    OpsCatchup,
    OpsPayload,
    Ping,
    PingPayload,
    PromptQueueOut,
    PromptSubmission,
    ResetPayload,
    ServerHello,
    ServerHelloPayload,
    SteerRequest,
    Subscribe,
    SubscribeAckPayload,
    TranscriptOps,
    TranscriptPage,
    TranscriptReset,
    Unsubscribe,
)

_logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 10.0
"""多久发一次 ping。照 kimi 的 ``DEFAULT_HEARTBEAT_INTERVAL_MS``。"""

HEARTBEAT_MISS_LIMIT = 2
"""连着几个周期没收到任何入站帧就断开（照 kimi 的 ``HEARTBEAT_MISS_LIMIT``）。

判据是「有没有入站帧」而不是「有没有收到 pong」：客户端发的任何一帧都证明它还在。
"""

MAX_EVENT_BUFFER = 512
"""一条连接最多积压几帧。积满说明这个客户端读不动了，断开让它重连补批，不能把服务端拖住。"""

_CLIENT_FRAME = TypeAdapter[Any](ClientFrame)


class Transcripts(Protocol):
    """transcript 那一侧的入口。这一层只需要这几件事，不需要认识它是怎么算出来的。"""

    async def submit(
        self,
        *,
        prompt_id: str,
        conversation_id: str,
        agent_id: str,
        owner_user_id: uuid.UUID,
        content: tuple[PromptContent, ...],
    ) -> Prompt: ...

    async def abort(self, conversation_id: str, prompt_id: str) -> None: ...

    async def abort_conversation(self, conversation_id: str) -> None: ...

    async def steer(self, conversation_id: str, prompt_ids: tuple[str, ...]) -> None: ...

    def approve(self, conversation_id: str, interaction_id: str, *, approved: bool) -> None: ...

    async def queue_view(self, conversation_id: str) -> PromptQueueOut: ...

    async def page(
        self,
        conversation_id: str,
        *,
        agent_id: str = MAIN_AGENT_ID,
        before_turn: str | None = None,
        after_turn: str | None = None,
        page_size: int = 20,
    ) -> TranscriptPage: ...

    def catchup(
        self, conversation_id: str, *, agent_id: str = MAIN_AGENT_ID, since: int
    ) -> OpsCatchup: ...

    def subscribe(
        self, conversation_id: str, *, agent_id: str = MAIN_AGENT_ID, since: int | None
    ) -> tuple[ResetPayload | OpsPayload, ...]: ...

    def listen(self, conversation_id: str, listener: Any, *, agent_id: str) -> None: ...

    def unlisten(self, conversation_id: str, listener: Any, *, agent_id: str) -> None: ...

    def pin(self, conversation_id: str) -> None: ...

    def unpin(self, conversation_id: str) -> None: ...


class Conversations(Protocol):
    """对话那一侧的入口：核对这段对话看不看得到、跑哪个 agent。"""

    async def agent_of(self, principal: Principal, conversation_id: str, *, writing: bool) -> str:
        """这段对话的 agent id；看不到就抛 ``NotFound``。

        ``writing`` 为真时只认属主。治理者读得到别人的对话，但不能替别人发消息、停别人的运行。
        """
        ...


ConversationId = Annotated[str, Path(pattern=r"^[A-Za-z0-9._-]{1,128}$")]


def create_transcript_router(
    transcripts: Transcripts,
    conversations: Conversations,
    *,
    allowed_origins: tuple[str, ...],
) -> APIRouter:
    """挂 transcript 的读写端点与订阅连接。"""

    # 两层前缀：里面这层是「挂在一段对话下面」的那些端点，外面这层多一条挂在对话本身上的
    # ``/conversations/{id}:abort``——前缀之后的路径一律以 ``/`` 开头，而 ``:abort`` 紧跟着 id。
    outer = APIRouter(prefix="/conversations", tags=["transcript"])
    router = APIRouter(prefix="/{conversation_id}", tags=["transcript"])

    async def _writable(principal: Principal, conversation_id: str) -> str:
        return await conversations.agent_of(principal, conversation_id, writing=True)

    async def _readable(principal: Principal, conversation_id: str) -> str:
        return await conversations.agent_of(principal, conversation_id, writing=False)

    @router.post("/prompts", response_model=Prompt)
    async def submit(
        conversation_id: ConversationId,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
        body: PromptSubmission,
    ) -> Prompt:
        """发一条消息。``prompt_id`` 由客户端铸，重发同一个不会多起一次运行。"""

        agent_id = await _writable(principal, conversation_id)
        return await transcripts.submit(
            prompt_id=body.prompt_id,
            conversation_id=conversation_id,
            agent_id=agent_id,
            owner_user_id=principal.user_id,
            content=body.content,
        )

    @router.get("/prompts", response_model=PromptQueueOut)
    async def queue_view(
        conversation_id: ConversationId,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> PromptQueueOut:
        await _readable(principal, conversation_id)
        return await transcripts.queue_view(conversation_id)

    @router.post("/prompts/{prompt_id}:abort", status_code=204)
    async def abort(
        conversation_id: ConversationId,
        prompt_id: ConversationId,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> None:
        """停掉一条消息。排队的直接撤，在跑的发第一方取消让它自己收尾。"""

        await _writable(principal, conversation_id)
        await transcripts.abort(conversation_id, prompt_id)

    @outer.post("/{conversation_id}:abort", status_code=204)
    async def abort_conversation(
        conversation_id: ConversationId,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> None:
        """停掉整段对话：排着的全撤，在跑的发第一方取消。

        没有在跑的、也没有排着的照样是 204：「停止」是用户按一次的动作，不该因为刚好停在
        什么都没有的那一刻而报错。
        """

        await _writable(principal, conversation_id)
        await transcripts.abort_conversation(conversation_id)

    @router.post("/prompts:steer", status_code=204)
    async def steer(
        conversation_id: ConversationId,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
        body: SteerRequest,
    ) -> None:
        """把排队中的几条插进正在跑的那一轮，不必等它跑完。"""

        await _writable(principal, conversation_id)
        await transcripts.steer(conversation_id, body.prompt_ids)

    @router.post("/interactions/{interaction_id}", status_code=204)
    async def approve(
        conversation_id: ConversationId,
        interaction_id: ConversationId,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
        body: ApprovalRequest,
    ) -> None:
        """对一张审批卡点同意或拒绝。工具就在同一次运行里等着这个回话。"""

        await _writable(principal, conversation_id)
        transcripts.approve(conversation_id, interaction_id, approved=body.approved)

    @router.get("/transcript", response_model=TranscriptPage)
    async def page(
        conversation_id: ConversationId,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
        before_turn: Annotated[str | None, Query()] = None,
        after_turn: Annotated[str | None, Query()] = None,
        page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> TranscriptPage:
        """一页轮子。不给位置就是最新那几轮，往上翻给 ``before_turn``。"""

        await _readable(principal, conversation_id)
        return await transcripts.page(
            conversation_id,
            before_turn=before_turn,
            after_turn=after_turn,
            page_size=page_size,
        )

    @router.get("/transcript/ops", response_model=OpsCatchup)
    async def catchup(
        conversation_id: ConversationId,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
        since_seq: Annotated[int, Query(ge=0)],
    ) -> OpsCatchup:
        """补上断线期间漏掉的批次。``complete`` 为假就整页重拉。"""

        await _readable(principal, conversation_id)
        return transcripts.catchup(conversation_id, since=since_seq)

    @router.websocket("/ws")
    async def subscribe(websocket: WebSocket, conversation_id: str) -> None:
        if not websocket_origin_allowed(websocket, allowed_origins):
            # 1008 = policy violation。在 accept 之前拒，连接根本不成立。
            await websocket.close(code=1008)
            return
        principal = websocket_principal(websocket)
        if principal is None or not principal.has("agent:run"):
            await websocket.close(code=1008)
            return
        try:
            await conversations.agent_of(principal, conversation_id, writing=False)
        except DomainError:
            await websocket.close(code=1008)
            return
        await _serve(websocket, transcripts, conversation_id)

    outer.include_router(router)
    return outer


class _Connection:
    """一条连接的一生：握手、订阅、边推边心跳。

    推送走一条有界队列，不在 store 的回调里直接发——回调是同步的（``append`` 的原子性靠它），
    而且一个读得慢的客户端不能把整个运行拖住。队列积满就断开，让它重连补批。
    """

    def __init__(self, websocket: WebSocket, transcripts: Transcripts, conversation_id: str):
        self._ws = websocket
        self._transcripts = transcripts
        self._conversation_id = conversation_id
        self._outbound: asyncio.Queue[Any] = asyncio.Queue(maxsize=MAX_EVENT_BUFFER)
        self._overflowed = False
        self._listening = False
        self._last_inbound = datetime.now(UTC)
        self._frame_seq = 0

    async def serve(self) -> None:
        await self._ws.accept()
        await self._send(
            ServerHello(
                timestamp=datetime.now(UTC).isoformat(),
                payload=ServerHelloPayload(
                    ws_connection_id=uuid.uuid4().hex,
                    heartbeat_ms=int(HEARTBEAT_SECONDS * 1000),
                    max_event_buffer_size=MAX_EVENT_BUFFER,
                ),
            )
        )
        self._transcripts.pin(self._conversation_id)
        # 发与心跳各自一个任务，收在这一层。不用 TaskGroup：它在被外层取消时会把取消再抛一遍，
        # 而这条连接的正常收场本来就是「客户端走了」，不该沿着异常往上冒。
        helpers = (asyncio.create_task(self._pump()), asyncio.create_task(self._heartbeat()))
        try:
            await self._read()
        except (WebSocketDisconnect, ConnectionError):
            # 客户端走了。这是正常收场，不是故障：它随时可能关页面或者断网。
            _logger.debug("订阅连接断开：conversation=%s", self._conversation_id)
        finally:
            for helper in helpers:
                helper.cancel()
            await asyncio.gather(*helpers, return_exceptions=True)
            self._unlisten()
            self._transcripts.unpin(self._conversation_id)

    # --- 收 -----------------------------------------------------------------

    async def _read(self) -> None:
        while True:
            raw = await self._ws.receive_text()
            self._last_inbound = datetime.now(UTC)
            try:
                frame = _CLIENT_FRAME.validate_json(raw)
            except ValidationError:
                # 认不出的帧丢掉，不断连接：协议往后加帧型是常事，旧服务端不该因此把人踢下线。
                continue
            await self._handle(frame)

    async def _handle(self, frame: Any) -> None:
        if isinstance(frame, ClientHello):
            await self._outbound.put(Ack(id=frame.id))
        elif isinstance(frame, Subscribe):
            await self._subscribe(frame)
        elif isinstance(frame, Unsubscribe):
            self._unlisten()
            await self._outbound.put(Ack(id=frame.id))

    async def _subscribe(self, frame: Subscribe) -> None:
        since = frame.payload.transcript_since.get(MAIN_AGENT_ID)
        # 先挂监听再取这一刻的帧：反过来的话，两步之间产生的批次谁也不发，客户端缺一段而且
        # 自己不知道。反向重复是安全的——同一个批次收两遍只是重放，收不到才是坏的。
        if not self._listening:
            self._transcripts.listen(self._conversation_id, self._on_batch, agent_id=MAIN_AGENT_ID)
            self._listening = True
        for item in self._transcripts.subscribe(self._conversation_id, since=since):
            await self._outbound.put(self._wrap(item))
        await self._outbound.put(
            Ack(id=frame.id, payload=SubscribeAckPayload(accepted=(self._conversation_id,)))
        )

    def _on_batch(self, batch: Any) -> None:
        try:
            self._outbound.put_nowait(
                self._wrap(OpsPayload(agent_id=MAIN_AGENT_ID, ops=batch.ops, seq=batch.seq))
            )
        except asyncio.QueueFull:
            self._overflowed = True

    def _wrap(self, payload: ResetPayload | OpsPayload) -> TranscriptReset | TranscriptOps:
        """给这份内容套上事件信封。

        信封上的 ``seq`` 是这条连接的第几帧，与 ``payload.seq``（transcript 的批次号）不是一
        回事：那个客户端要记账，这个只是编号。
        """

        self._frame_seq += 1
        stamped = datetime.now(UTC).isoformat()
        if isinstance(payload, ResetPayload):
            return TranscriptReset(
                seq=self._frame_seq,
                session_id=self._conversation_id,
                timestamp=stamped,
                payload=payload,
            )
        return TranscriptOps(
            seq=self._frame_seq,
            session_id=self._conversation_id,
            timestamp=stamped,
            payload=payload,
        )

    def _unlisten(self) -> None:
        if self._listening:
            self._transcripts.unlisten(
                self._conversation_id, self._on_batch, agent_id=MAIN_AGENT_ID
            )
            self._listening = False

    # --- 发 -----------------------------------------------------------------

    async def _pump(self) -> None:
        while True:
            frame = await self._outbound.get()
            if self._overflowed:
                # 1013 = try again later。丢过帧之后再发就是给客户端一条有缺口的流，
                # 它会拿着错的水位往下走；断开让它重连补批。
                await self._ws.close(code=1013)
                return
            await self._send(frame)

    async def _heartbeat(self) -> None:
        """定期 ping，连着几个周期没有任何入站帧就断开。

        判「有没有入站」而不是「有没有收到 pong」：客户端发的任何一帧都证明它还在。
        """

        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            idle = (datetime.now(UTC) - self._last_inbound).total_seconds()
            if idle >= HEARTBEAT_SECONDS * HEARTBEAT_MISS_LIMIT:
                await self._ws.close(code=1001)
                return
            with contextlib.suppress(asyncio.QueueFull):
                self._outbound.put_nowait(Ping(payload=PingPayload(nonce=uuid.uuid4().hex[:8])))

    async def _send(self, frame: Any) -> None:
        """帧里嵌的实体与操作必须按别名出去（``turnId`` 而不是 ``turn_id``）。

        少了 ``by_alias`` 客户端会整帧丢掉且不报错——它的 reducer 是照抄来的 zod，形状对不上
        就是 safeParse 失败，界面永远停在空白。REST 那侧不会犯这个错：FastAPI 的
        ``response_model`` 默认就按别名序列化，只有这里是手工发的。
        """

        try:
            await self._ws.send_text(frame.model_dump_json(exclude_none=True, by_alias=True))
        except RuntimeError as exc:
            # 客户端刚走，starlette 对「关了之后再发」抛的是 RuntimeError。它和收那一侧的
            # WebSocketDisconnect 是同一件事，翻译过来交给外面统一收尾。
            raise WebSocketDisconnect(code=1006) from exc


async def _serve(websocket: WebSocket, transcripts: Transcripts, conversation_id: str) -> None:
    await _Connection(websocket, transcripts, conversation_id).serve()


__all__ = [
    "HEARTBEAT_MISS_LIMIT",
    "HEARTBEAT_SECONDS",
    "MAX_EVENT_BUFFER",
    "Conversations",
    "Transcripts",
    "create_transcript_router",
]
