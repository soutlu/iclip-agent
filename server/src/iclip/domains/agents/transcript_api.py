"""Transcript REST 端点与多对话 WebSocket。逐对话校验订阅权限，引擎访问通过注入协议完成。

WebSocket 握手不受 CORS 约束且会携带 cookie，必须独立校验 Origin，防止跨站劫持。"""

from __future__ import annotations

import asyncio
import contextlib
import re
import uuid
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Protocol

import structlog
from fastapi import APIRouter, Depends, Path, Query, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from iclip.common.errors import DomainError
from iclip.common.generation_vocab import GenerationKind, GenerationStatus
from iclip.domains.identity.public import (
    MANAGE_PERMISSION,
    ActAs,
    Principal,
    require_permission,
    resolve_user_name,
    websocket_origin_allowed,
    websocket_principal,
)
from iclip.platform.transcript.granularity import (
    TranscriptGrade,
    filter_ops_for_grade,
    grade_for,
    needs_reset_on_transition,
)
from iclip.platform.transcript.ops import MAIN_AGENT_ID, Prompt, PromptContent
from iclip.platform.transcript.wire import (
    Ack,
    ApprovalRequest,
    ClientFrame,
    FsChanged,
    FsChangeEntry,
    FsChangePayload,
    GenerationChanged,
    GenerationChangedPayload,
    OpsCatchup,
    OpsPayload,
    Ping,
    PingPayload,
    PromptQueueOut,
    PromptSubmission,
    RegenerateBody,
    ResetPayload,
    RunStatusOut,
    ServerHello,
    ServerHelloPayload,
    SessionMetaPayload,
    SessionMetaUpdated,
    SessionWorkChanged,
    SessionWorkPayload,
    SteerRequest,
    Subscribe,
    SubscribeAckPayload,
    SubscribePayload,
    TranscriptOps,
    TranscriptPage,
    TranscriptReset,
    Unsubscribe,
    WatchFsAckPayload,
    WatchFsAdd,
    WatchFsRemove,
)

_logger = structlog.stdlib.get_logger(__name__)

HEARTBEAT_SECONDS = 10.0
"""心跳间隔，与 kimi DEFAULT_HEARTBEAT_INTERVAL_MS 对齐。"""

HEARTBEAT_MISS_LIMIT = 2
"""连续无入站帧达到此周期数时断开；任意客户端帧均可证明连接存活。"""

MAX_EVENT_BUFFER = 2048
"""多对话共享的连接出站缓冲上限；溢出时断开并要求重连补批，避免阻塞运行。"""

_CLIENT_FRAME = TypeAdapter[Any](ClientFrame)


class Transcripts(Protocol):
    """供 HTTP 与 WebSocket 使用的 Transcript 入口协议。"""

    async def submit(
        self,
        *,
        prompt_id: str,
        conversation_id: str,
        agent_id: str,
        owner_user_id: uuid.UUID,
        user_name: str,
        content: tuple[PromptContent, ...],
    ) -> Prompt: ...

    async def abort(self, conversation_id: str, prompt_id: str) -> None: ...

    async def regenerate(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        prompt_id: str | None = None,
        content: tuple[PromptContent, ...] | None = None,
    ) -> Prompt: ...

    async def abort_conversation(self, conversation_id: str) -> None: ...

    async def steer(self, conversation_id: str, prompt_ids: tuple[str, ...]) -> None: ...

    async def approve(
        self, conversation_id: str, interaction_id: str, *, approved: bool
    ) -> None: ...

    async def queue_view(self, conversation_id: str) -> PromptQueueOut: ...

    async def run_status(self, conversation_id: str) -> RunStatusOut: ...

    async def verify_agent(self, conversation_id: str, agent_id: str) -> None:
        """agent 不属于这段对话时抛 NotFound；要在读实时状态之前调。"""
        ...

    async def page(
        self,
        conversation_id: str,
        *,
        agent_id: str = MAIN_AGENT_ID,
        runtime_agent_id: str,
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


class ConversationHeader(Protocol):
    """会话页首屏要贴在信封顶层的几项，外加读这一页要用的 Agent id。"""

    @property
    def agent_id(self) -> str: ...

    @property
    def title(self) -> str: ...

    @property
    def owner_user_id(self) -> uuid.UUID: ...

    @property
    def deleted_at(self) -> datetime | None: ...

    @property
    def forked_from(self) -> uuid.UUID | None: ...

    @property
    def fork_turn(self) -> int | None: ...


class Conversations(Protocol):
    """对话可见性与 Agent 绑定查询协议。"""

    async def agent_of(self, principal: Principal, conversation_id: str, *, writing: bool) -> str:
        """读取可见对话的 Agent id；writing=True 时仅允许属主，不可见时抛 NotFound。"""
        ...

    async def header_of(self, principal: Principal, conversation_id: str) -> ConversationHeader:
        """读取可见对话的首屏信息，可见范围同 ``agent_of(writing=False)``；不可见时抛 NotFound。"""
        ...


ProtocolId = Annotated[str, Path(pattern=r"^[A-Za-z0-9._-]{1,128}$")]
"""协议里由客户端铸的路径标识：消息 id、交互 id 与轮 id，不是 UUID（轮 id 长 ``t1`` 这样）。"""


def _canonical_conversation_id(conversation_id: uuid.UUID) -> str:
    """路径上的对话 id 按 UUID 解析后规范化。

    调用方写不写横线都命中同一段对话，而工作区与实时状态只见到一种拼写
    （见 ``ConversationService`` 对规范写法的要求）。"""

    return str(conversation_id)


ConversationId = Annotated[str, Depends(_canonical_conversation_id)]


def _canonical_session_id(session_id: str) -> str | None:
    """WS 帧里的对话 id 按 UUID 解析后规范化；不是 UUID 就是 ``None``。

    与 REST 路径同一条规则，无横线写法照样命中那段对话；调用方按 ``None`` 走不可见的同一个
    应答，不区分「写法不对」和「看不见」。"""

    try:
        return str(uuid.UUID(session_id))
    except ValueError:
        return None


_AGENT_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
"""协议的 agent id 形状：主 agent 是 main，子代理是它的 run id。"""

AgentId = Annotated[str, Query(pattern=_AGENT_ID.pattern)]


def _subscribed_agents(spec: Mapping[str, TranscriptGrade]) -> tuple[str, ...]:
    """订阅表里点名的 agent；`*` 只落到主 agent 上，子代理要点名订。"""

    named = [agent_id for agent_id in spec if agent_id != "*"]
    if "*" in spec and MAIN_AGENT_ID not in named:
        named.insert(0, MAIN_AGENT_ID)
    return tuple(named)


class LiveConnections:
    """当前进程的 WebSocket 连接集合。

    标题、活动与生成任务广播不依赖对话订阅，发给属主的连接和治理者的连接，范围由握手主体定。
    多 worker 各自持有连接集合，未收到广播的客户端需重新读取数据库状态。"""

    def __init__(self) -> None:
        self._connections: set[_Connection] = set()

    def add(self, connection: _Connection) -> None:
        self._connections.add(connection)

    def discard(self, connection: _Connection) -> None:
        self._connections.discard(connection)

    def announce_title(self, owner: uuid.UUID, conversation_id: uuid.UUID, title: str) -> None:
        """向属主与治理者的连接广播标题更新。"""

        self._announce(
            owner,
            SessionMetaUpdated(
                payload=SessionMetaPayload(session_id=str(conversation_id), title=title)
            ),
        )

    def announce_activity(
        self,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        busy: bool,
        pending_interaction: Literal["none", "approval", "question"],
        last_turn_reason: Literal["completed", "failed", "aborted"] | None,
    ) -> None:
        """向属主与治理者的连接广播活动状态；使用基础字段避免依赖引擎类型。"""

        self._announce(
            owner,
            SessionWorkChanged(
                session_id=str(conversation_id),
                payload=SessionWorkPayload(
                    busy=busy,
                    pending_interaction=pending_interaction,
                    last_turn_reason=last_turn_reason,
                ),
            ),
        )

    def announce_generation_changed(
        self,
        owner: uuid.UUID,
        conversation_id: uuid.UUID | None,
        *,
        job_id: uuid.UUID,
        kind: GenerationKind,
        status: GenerationStatus,
        metadata: Mapping[str, Any] | None,
    ) -> None:
        """向属主与治理者的连接广播生成任务状态跳转；只收基础字段与 common 的词表，不依赖生成域类型。"""

        self._announce(
            owner,
            GenerationChanged(
                session_id=None if conversation_id is None else str(conversation_id),
                payload=GenerationChangedPayload(
                    id=str(job_id),
                    kind=kind,
                    status=status,
                    metadata=None if metadata is None else dict(metadata),
                ),
            ),
        )

    def announce_fs_changed(
        self,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        path: str,
        change: Literal["created", "modified", "deleted"] = "modified",
    ) -> None:
        """通知属主与治理者的连接，仅发送给通过 watch_fs_add 订阅对应路径的连接。"""

        for connection in tuple(self._connections):
            if connection.receives(owner):
                connection.offer_fs_change(str(conversation_id), path, change)

    def _announce(self, owner: uuid.UUID, frame: Any) -> None:
        # 回调可能移除连接，遍历副本避免迭代集合被修改。
        for connection in tuple(self._connections):
            if connection.receives(owner):
                connection.offer(frame)


def create_transcript_router(
    transcripts: Transcripts,
    conversations: Conversations,
    *,
    act_as: ActAs,
    allowed_origins: tuple[str, ...],
    live: LiveConnections,
) -> APIRouter:
    """挂 transcript 的读写端点与订阅连接。"""

    # :abort 紧跟对话 id，无法复用带尾部斜杠的前缀；与 /ws 一起挂在外层路由。
    outer = APIRouter(tags=["transcript"])
    router = APIRouter(prefix="/conversations/{conversation_id}", tags=["transcript"])

    async def _writable(principal: Principal, conversation_id: str) -> str:
        return await conversations.agent_of(principal, conversation_id, writing=True)

    async def _readable(principal: Principal, conversation_id: str) -> str:
        return await conversations.agent_of(principal, conversation_id, writing=False)

    @router.post("/prompts", response_model=Prompt)
    async def submit(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:run")],
        body: PromptSubmission,
    ) -> Prompt:
        """发一条消息。``prompt_id`` 由客户端铸，重发同一个不会多起一次运行。

        ``user_name`` 是这条消息替谁发的：API key 调用方必须给，浏览器会话默认是登录用户名。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        agent_id = await _writable(principal, conversation_id)
        return await transcripts.submit(
            prompt_id=body.prompt_id,
            conversation_id=conversation_id,
            agent_id=agent_id,
            owner_user_id=principal.user_id,
            user_name=user_name,
            content=body.content,
        )

    @router.get("/prompts", response_model=PromptQueueOut)
    async def queue_view(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> PromptQueueOut:
        await _readable(principal, conversation_id)
        return await transcripts.queue_view(conversation_id)

    @router.get("/status", response_model=RunStatusOut)
    async def run_status(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:read")],
    ) -> RunStatusOut:
        """这段对话跑没跑完、有没有出错。只读，凭 API key 可单独轮询。"""

        await _readable(principal, conversation_id)
        return await transcripts.run_status(conversation_id)

    @router.post("/prompts/{prompt_id}:abort", status_code=204)
    async def abort(
        conversation_id: ConversationId,
        prompt_id: ProtocolId,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> None:
        """停掉一条消息。排队的直接撤，在跑的发第一方取消让它自己收尾。"""

        await _writable(principal, conversation_id)
        await transcripts.abort(conversation_id, prompt_id)

    @router.post("/turns/{turn_id}:regenerate", response_model=Prompt)
    async def regenerate(
        conversation_id: ConversationId,
        turn_id: ProtocolId,
        principal: Annotated[Principal, require_permission("agent:run")],
        body: RegenerateBody | None = None,
    ) -> Prompt:
        """重新生成最后一轮：把它从历史里抹掉重跑一次，答复是重跑那条的记录。

        ``turn_id`` 是协议里的轮 id（``t{N}``），客户端从轮头部直接拿得到。请求体可以不带：
        带 ``content`` 就换成新内容重跑，带 ``prompt_id`` 就与发消息同一套幂等。
        """

        await _writable(principal, conversation_id)
        return await transcripts.regenerate(
            conversation_id=conversation_id,
            turn_id=turn_id,
            prompt_id=None if body is None else body.prompt_id,
            content=None if body is None else body.content,
        )

    @outer.post("/conversations/{conversation_id}:abort", status_code=204)
    async def abort_conversation(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:run")],
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
        principal: Annotated[Principal, require_permission("agent:run")],
        body: SteerRequest,
    ) -> None:
        """把排队中的几条插进正在跑的那一轮，不必等它跑完。"""

        await _writable(principal, conversation_id)
        await transcripts.steer(conversation_id, body.prompt_ids)

    @router.post("/interactions/{interaction_id}", status_code=204)
    async def approve(
        conversation_id: ConversationId,
        interaction_id: ProtocolId,
        principal: Annotated[Principal, require_permission("agent:run")],
        body: ApprovalRequest,
    ) -> None:
        """对一张审批卡点同意或拒绝。

        决定记下就返回 204：那次运行已经以「等审批」结束了，凑齐这一批之后服务端自己起续跑。
        重复点同一个决定照样 204；改主意是 409；卡不在等回应的那几张里是 404。
        """

        await _writable(principal, conversation_id)
        await transcripts.approve(conversation_id, interaction_id, approved=body.approved)

    @router.get("/transcript", response_model=TranscriptPage)
    async def page(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:run")],
        agent_id: AgentId = MAIN_AGENT_ID,
        before_turn: Annotated[str | None, Query()] = None,
        after_turn: Annotated[str | None, Query()] = None,
        page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> TranscriptPage:
        """一页轮子。不给位置就是最新那几轮，往上翻给 ``before_turn``。

        ``agent_id`` 默认主 agent；给子代理的 id 就读它那条流，不属于这段对话的 id 是 404。
        标题在这里贴上：引擎那一侧不认识对话表，而首屏得有个名字显示（之后的改名走
        ``session.meta.updated`` 推送，不再问这里）。
        """

        header = await conversations.header_of(principal, conversation_id)
        await transcripts.verify_agent(conversation_id, agent_id)
        page = await transcripts.page(
            conversation_id,
            agent_id=agent_id,
            runtime_agent_id=header.agent_id,
            before_turn=before_turn,
            after_turn=after_turn,
            page_size=page_size,
        )
        return page.model_copy(
            update={
                "title": header.title,
                "owner_user_id": str(header.owner_user_id),
                "deleted_at": None if header.deleted_at is None else header.deleted_at.isoformat(),
                "forked_from": None if header.forked_from is None else str(header.forked_from),
                "fork_turn": header.fork_turn,
            }
        )

    @router.get("/transcript/ops", response_model=OpsCatchup)
    async def catchup(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:run")],
        since_seq: Annotated[int, Query(ge=0)],
        agent_id: AgentId = MAIN_AGENT_ID,
    ) -> OpsCatchup:
        """补上断线期间漏掉的批次。``complete`` 为假就整页重拉。"""

        await _readable(principal, conversation_id)
        await transcripts.verify_agent(conversation_id, agent_id)
        return transcripts.catchup(conversation_id, agent_id=agent_id, since=since_seq)

    @outer.websocket("/ws")
    async def subscribe(websocket: WebSocket) -> None:
        """一条连接管这个人的所有对话。哪几段由 ``subscribe_v2`` 说，逐段核权。"""

        if not websocket_origin_allowed(websocket, allowed_origins):
            # 握手前以 policy violation 拒绝连接。
            _logger.info(
                "订阅连接被拒：Origin 不同源",
                origin=websocket.headers.get("origin"),
                host=websocket.headers.get("host"),
            )
            await websocket.close(code=1008)
            return
        principal = websocket_principal(websocket)
        if principal is None:
            # 仅记录凭证是否存在，区分缺失与解析失败，避免泄露凭证。
            _logger.info(
                "订阅连接被拒：没有身份",
                has_cookie="cookie" in websocket.headers,
                has_authorization="authorization" in websocket.headers,
            )
            await websocket.close(code=1008)
            return
        if not principal.has("agent:run"):
            _logger.info("订阅连接被拒：没有 agent:run", user_id=principal.user_id)
            await websocket.close(code=1008)
            return
        await _serve(websocket, transcripts, conversations, principal, live)

    outer.include_router(router)
    return outer


class _Connection:
    """多对话 WebSocket 连接。各对话独立监听，帧通过 session_id 分流。

    同步监听回调仅写入有界出站队列，避免慢客户端阻塞运行；缓冲溢出时断开以便重连补批。

    帧里的对话 id 两种写法都收，订阅、文件监听与回发的 ``session_id`` 一律用规范写法：客户端按
    ``session_id`` 分流，全局帧与 REST 也只给这一种拼写，多一种会让同一段对话在客户端裂成两份。"""

    def __init__(
        self,
        websocket: WebSocket,
        transcripts: Transcripts,
        conversations: Conversations,
        principal: Principal,
    ):
        self._ws = websocket
        self._transcripts = transcripts
        self._conversations = conversations
        self._principal = principal
        self._outbound: asyncio.Queue[Any] = asyncio.Queue(maxsize=MAX_EVENT_BUFFER)
        self._overflowed = False
        # 监听与档位按 (对话, agent) 分键：一段对话里主流与各子代理流各订各的。
        self._listeners: dict[tuple[str, str], Callable[[Any], None]] = {}
        self._grades: dict[tuple[str, str], TranscriptGrade] = {}
        # 文件订阅按对话记录路径与递归标记，独立于 Transcript 订阅。
        self._watches: dict[str, dict[str, bool]] = {}
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
        # 显式管理发送与心跳任务，将客户端断开统一作为连接正常结束处理。
        helpers = (asyncio.create_task(self._pump()), asyncio.create_task(self._heartbeat()))
        try:
            await self._read()
        except (WebSocketDisconnect, ConnectionError):
            _logger.debug("订阅连接断开", conversations=len(self._listeners))
        finally:
            for helper in helpers:
                helper.cancel()
            await asyncio.gather(*helpers, return_exceptions=True)
            for conversation_id in {key[0] for key in self._listeners}:
                self._unlisten(conversation_id)

    async def _read(self) -> None:
        while True:
            raw = await self._ws.receive_text()
            self._last_inbound = datetime.now(UTC)
            try:
                frame = _CLIENT_FRAME.validate_json(raw)
            except ValidationError:
                # 忽略未知帧类型，兼容新增协议帧。
                continue
            await self._handle(frame)

    async def _handle(self, frame: Any) -> None:
        if isinstance(frame, Subscribe):
            await self._subscribe(frame)
        elif isinstance(frame, Unsubscribe):
            # 退订本就幂等，写法不对的 id 记账里必然没有，撤不到什么照样回执。
            raw = frame.payload.session_id
            self._unlisten(_canonical_session_id(raw) or raw, frame.payload.agent_ids)
            await self._outbound.put(Ack(id=frame.id))
        elif isinstance(frame, WatchFsAdd):
            await self._watch_fs(frame)
        elif isinstance(frame, WatchFsRemove):
            raw = frame.payload.session_id
            conversation_id = _canonical_session_id(raw) or raw
            watched = self._watches.get(conversation_id, {})
            for path in frame.payload.paths:
                watched.pop(path, None)
            if not watched:
                self._watches.pop(conversation_id, None)
            await self._outbound.put(Ack(id=frame.id, payload=self._watch_ack(conversation_id)))

    async def _visible(self, session_id: str) -> str | None:
        """帧里的对话 id 规范化并核可见性，拿不到就是 ``None``。

        写法不是 UUID、对话不存在、对当前主体不可见，三者同一个结果，不泄露存在性。"""

        conversation_id = _canonical_session_id(session_id)
        if conversation_id is None:
            return None
        try:
            await self._conversations.agent_of(self._principal, conversation_id, writing=False)
        except DomainError:
            return None
        return conversation_id

    async def _watch_fs(self, frame: WatchFsAdd) -> None:
        conversation_id = await self._visible(frame.payload.session_id)
        if conversation_id is None:
            # 看不见的对话保留连接上的其他订阅。
            await self._outbound.put(Ack(id=frame.id, code=40401, msg="会话不存在"))
            return
        watched = self._watches.setdefault(conversation_id, {})
        for path in frame.payload.paths:
            watched[path] = frame.payload.recursive
        await self._outbound.put(Ack(id=frame.id, payload=self._watch_ack(conversation_id)))

    def _watch_ack(self, conversation_id: str) -> WatchFsAckPayload:
        watched = self._watches.get(conversation_id, {})
        return WatchFsAckPayload(
            watched_paths=tuple(sorted(watched)),
            current_count=sum(len(paths) for paths in self._watches.values()),
        )

    def _watching(self, conversation_id: str, path: str) -> bool:
        """匹配文件精确订阅或目录订阅范围；空串是工作区根，订它就能看到整个工作区的变动。"""

        for watched, recursive in self._watches.get(conversation_id, {}).items():
            if watched == path:
                return True
            if watched == "":
                inside = path
            elif path.startswith(watched + "/"):
                inside = path[len(watched) + 1 :]
            else:
                continue
            if recursive or "/" not in inside:
                return True
        return False

    def offer_fs_change(
        self, conversation_id: str, path: str, change: Literal["created", "modified", "deleted"]
    ) -> None:

        if not self._watching(conversation_id, path):
            return
        self._frame_seq += 1
        self.offer(
            FsChanged(
                seq=self._frame_seq,
                session_id=conversation_id,
                timestamp=datetime.now(UTC).isoformat(),
                payload=FsChangePayload(changes=(FsChangeEntry(path=path, change=change),)),
            )
        )

    async def _subscribe(self, frame: Subscribe) -> None:
        conversation_id = await self._visible(frame.payload.session_id)
        if conversation_id is None:
            # 不泄露不可见对话的存在性，也不影响连接上的其他订阅。
            # 拒了的写法没有规范形式，回执里原样带回客户端问的那个。
            await self._outbound.put(
                Ack(
                    id=frame.id,
                    payload=SubscribeAckPayload(not_found=(frame.payload.session_id,)),
                )
            )
            return
        agent_ids = _subscribed_agents(frame.payload.transcript)
        for agent_id in agent_ids:
            # 陌生或不属于这段对话的 agent：整帧不生效，已有订阅保持原样。
            if not _AGENT_ID.fullmatch(agent_id) or not await self._owns(conversation_id, agent_id):
                await self._outbound.put(
                    Ack(id=frame.id, code=404, msg=f"agent not in session: {agent_id}")
                )
                return
        for agent_id in agent_ids:
            await self._subscribe_agent(conversation_id, agent_id, frame.payload)
        await self._outbound.put(
            Ack(id=frame.id, payload=SubscribeAckPayload(accepted=(conversation_id,)))
        )

    async def _owns(self, conversation_id: str, agent_id: str) -> bool:
        try:
            await self._transcripts.verify_agent(conversation_id, agent_id)
        except DomainError:
            return False
        return True

    async def _subscribe_agent(
        self, conversation_id: str, agent_id: str, payload: SubscribePayload
    ) -> None:
        key = (conversation_id, agent_id)
        grade = grade_for(payload.transcript, agent_id)
        previous = self._grades.get(key)
        self._grades[key] = grade
        since = payload.transcript_since.get(agent_id)
        if previous is not None and needs_reset_on_transition(previous, grade):
            # 提高订阅粒度后缺少此前过滤的操作，必须重置快照，不能沿用旧水位。
            since = None
        # 先监听再取快照，避免丢失间隙批次；重复批次可安全重放。
        if key not in self._listeners:
            if not self._listening(conversation_id):
                self._transcripts.pin(conversation_id)
            listener = self._listener_for(conversation_id, agent_id)
            self._listeners[key] = listener
            self._transcripts.listen(conversation_id, listener, agent_id=agent_id)
        # off 保留订阅，仅停止发送此 Agent 的帧。
        if grade != "off":
            for item in self._transcripts.subscribe(
                conversation_id, agent_id=agent_id, since=since
            ):
                await self._outbound.put(self._wrap(conversation_id, self._graded(item, grade)))

    def _listening(self, conversation_id: str) -> bool:
        return any(key[0] == conversation_id for key in self._listeners)

    def receives(self, owner: uuid.UUID) -> bool:
        """全局帧与文件变更帧发给谁：属主自己的连接，和治理者的连接。

        权限按握手时的主体快照，吊销后要重连才生效。"""

        return self._principal.user_id == owner or self._principal.has(MANAGE_PERMISSION)

    def offer(self, frame: Any) -> None:
        """加入出站队列，容量不足时标记溢出。"""

        try:
            self._outbound.put_nowait(frame)
        except asyncio.QueueFull:
            self._overflowed = True

    def _listener_for(self, conversation_id: str, agent_id: str) -> Callable[[Any], None]:
        """创建绑定一段对话里某个 agent 流的批次监听回调。"""

        def on_batch(batch: Any) -> None:
            grade = self._grades.get((conversation_id, agent_id), "off")
            ops = filter_ops_for_grade(grade, batch.ops)
            if not ops:
                # 空批次不发送；过滤后的操作可重放，重连时重复读取安全。
                return
            try:
                self._outbound.put_nowait(
                    self._wrap(
                        conversation_id,
                        OpsPayload(agent_id=agent_id, ops=ops, seq=batch.seq),
                    )
                )
            except asyncio.QueueFull:
                self._overflowed = True

        return on_batch

    @staticmethod
    def _graded(
        payload: ResetPayload | OpsPayload, grade: TranscriptGrade
    ) -> ResetPayload | OpsPayload:
        """按订阅粒度过滤补批；reset 的 items 恒为空，直接保留。"""

        if isinstance(payload, ResetPayload):
            return payload
        return payload.model_copy(update={"ops": filter_ops_for_grade(grade, payload.ops)})

    def _wrap(
        self, conversation_id: str, payload: ResetPayload | OpsPayload
    ) -> TranscriptReset | TranscriptOps:
        """封装事件。外层 seq 是连接帧序号，payload.seq 才是客户端续传使用的 Transcript 批次号。"""

        self._frame_seq += 1
        stamped = datetime.now(UTC).isoformat()
        if isinstance(payload, ResetPayload):
            return TranscriptReset(
                seq=self._frame_seq,
                session_id=conversation_id,
                timestamp=stamped,
                payload=payload,
            )
        return TranscriptOps(
            seq=self._frame_seq,
            session_id=conversation_id,
            timestamp=stamped,
            payload=payload,
        )

    def _unlisten(self, conversation_id: str, agent_ids: Sequence[str] = ()) -> None:
        """幂等退订；不点名就撤这段对话的全部 agent，最后一个撤掉时放开实时状态的引用。"""

        keys = [
            key
            for key in self._listeners
            if key[0] == conversation_id and (not agent_ids or key[1] in agent_ids)
        ]
        for key in keys:
            self._grades.pop(key, None)
            self._transcripts.unlisten(conversation_id, self._listeners.pop(key), agent_id=key[1])
        if keys and not self._listening(conversation_id):
            self._transcripts.unpin(conversation_id)

    async def _pump(self) -> None:
        while True:
            frame = await self._outbound.get()
            if self._overflowed:
                # 溢出后流已存在缺口，以 1013 断开，要求客户端重连补批。
                await self._ws.close(code=1013)
                return
            await self._send(frame)

    async def _heartbeat(self) -> None:
        """定期发送 ping，连续多个周期没有任何入站帧时断开。"""

        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            idle = (datetime.now(UTC) - self._last_inbound).total_seconds()
            if idle >= HEARTBEAT_SECONDS * HEARTBEAT_MISS_LIMIT:
                await self._ws.close(code=1001)
                return
            with contextlib.suppress(asyncio.QueueFull):
                self._outbound.put_nowait(Ping(payload=PingPayload(nonce=uuid.uuid4().hex[:8])))

    async def _send(self, frame: Any) -> None:
        """按字段别名序列化实体和操作，以匹配客户端协议；WebSocket 不经过 FastAPI 响应序列化。"""

        try:
            await self._ws.send_text(frame.model_dump_json(exclude_none=True, by_alias=True))
        except RuntimeError as exc:
            # Starlette 在关闭后发送时抛 RuntimeError，统一转换为连接断开。
            raise WebSocketDisconnect(code=1006) from exc


async def _serve(
    websocket: WebSocket,
    transcripts: Transcripts,
    conversations: Conversations,
    principal: Principal,
    live: LiveConnections,
) -> None:
    connection = _Connection(websocket, transcripts, conversations, principal)
    live.add(connection)
    try:
        await connection.serve()
    finally:
        live.discard(connection)


__all__ = [
    "HEARTBEAT_MISS_LIMIT",
    "HEARTBEAT_SECONDS",
    "MAX_EVENT_BUFFER",
    "ConversationHeader",
    "Conversations",
    "LiveConnections",
    "Transcripts",
    "create_transcript_router",
]
