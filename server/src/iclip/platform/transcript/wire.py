"""transcript 的信封：WS 帧与 REST 响应的外层形状。

**这一层的字段名是 snake_case，里面装的实体与操作是 camelCase。** 两种写法在同一个 JSON 里
并存不是笔误，是协议本来的样子（``packages/transcript/src/contract/schema.ts``）：

    {"type": "transcript.reset", "agent_id": "main", "seq": 12,
     "snapshot": {"items": [], "hasMoreOlder": true, ...}}

客户端那侧用的是照抄过来的 zod schema，它按这个形状校验，改一个字母就整帧被拒。仓内其余端点
仍是 camelCase（见 contract/conventions.md）。

``seq`` 在协议里标成可选，**我们发的每一帧 reset 都必须带上它**。客户端收到 reset 会把本地
水位无条件覆写成这个数（不是取较大值），这正是进程重启后批次号从 1 重来仍然安全的原因。不带
的话客户端会守着上一代的水位，后面的批次全被当成旧的丢掉，界面就此不再更新。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from iclip.platform.transcript.ops import (
    Attachment,
    EmittableOperation,
    Interaction,
    Prompt,
    TranscriptMeta,
    TranscriptSnapshot,
    TranscriptTurn,
)


class _Envelope(BaseModel):
    """信封层：字段名原样，不转 camelCase。"""

    model_config = ConfigDict(extra="forbid", frozen=True)


# --- WS：服务端发给客户端 -----------------------------------------------------


class ServerHelloCapabilities(_Envelope):
    event_batching: bool = False
    compression: bool = False


class ServerHelloPayload(_Envelope):
    ws_connection_id: str
    protocol_version: int = 2
    heartbeat_ms: int
    max_event_buffer_size: int


class ServerHello(_Envelope):
    type: Literal["server_hello"] = "server_hello"
    timestamp: str
    payload: ServerHelloPayload
    capabilities: ServerHelloCapabilities = ServerHelloCapabilities()


class TranscriptReset(_Envelope):
    """订阅时的第一帧。``has_more_older`` 在 snapshot 外面，协议就是这么放的。"""

    type: Literal["transcript.reset"] = "transcript.reset"
    agent_id: str
    snapshot: TranscriptSnapshot
    has_more_older: bool = True
    seq: int


class TranscriptOps(_Envelope):
    """一批操作。``seq`` 是这一批的批次号，每 agent 连续。"""

    type: Literal["transcript.ops"] = "transcript.ops"
    agent_id: str
    ops: tuple[EmittableOperation, ...]
    seq: int


class Ack(_Envelope):
    """控制帧的回执。``code`` 为 0 即成功，与协议一致。"""

    type: Literal["ack"] = "ack"
    id: str
    code: int = 0
    msg: str = ""
    payload: Any = None


class SubscribeAckPayload(_Envelope):
    accepted: tuple[str, ...] = ()
    not_found: tuple[str, ...] = ()
    resync_required: tuple[str, ...] = ()


class Ping(_Envelope):
    type: Literal["ping"] = "ping"


ServerFrame = Annotated[
    ServerHello | TranscriptReset | TranscriptOps | Ack | Ping,
    Field(discriminator="type"),
]


# --- WS：客户端发给服务端 -----------------------------------------------------


class ClientHelloPayload(_Envelope):
    client_id: str


class ClientHello(_Envelope):
    type: Literal["client_hello"] = "client_hello"
    id: str = ""
    payload: ClientHelloPayload


class SubscribePayload(_Envelope):
    """``transcript`` 是每个 agent 要哪一档，我们只产出 ``delta``。

    ``transcript_since`` 是客户端手上的水位，按 agent 给；给了就补那之后的批次。
    """

    session_id: str
    transcript: dict[str, Literal["off", "turn", "block", "delta"]] = Field(default_factory=dict)
    transcript_since: dict[str, int] = Field(default_factory=dict)


class Subscribe(_Envelope):
    type: Literal["subscribe_v2"] = "subscribe_v2"
    id: str
    payload: SubscribePayload


class UnsubscribePayload(_Envelope):
    session_id: str
    agent_ids: tuple[str, ...] = ()


class Unsubscribe(_Envelope):
    type: Literal["unsubscribe_v2"] = "unsubscribe_v2"
    id: str
    payload: UnsubscribePayload


class Pong(_Envelope):
    type: Literal["pong"] = "pong"


ClientFrame = Annotated[
    ClientHello | Subscribe | Unsubscribe | Pong,
    Field(discriminator="type"),
]


# --- REST --------------------------------------------------------------------


class TranscriptPage(_Envelope):
    """``GET /transcript`` 的一页。

    ``agents`` 与 ``pending_interactions`` 是协议要求的字段，我们只有主 agent，前者恒为一条、
    后者从待回应的交互里取。
    """

    agent_id: str
    items: tuple[TranscriptTurn, ...]
    has_more: bool
    tasks: tuple[Any, ...] = ()
    interactions: tuple[Interaction, ...] = ()
    attachments: tuple[Attachment, ...] = ()
    todos: tuple[Any, ...] = ()
    prompts: tuple[Prompt, ...] = ()
    meta: TranscriptMeta = TranscriptMeta()
    agents: tuple[dict[str, Any], ...] = ()
    pending_interactions: tuple[str, ...] = ()
    seq: int


class OpsBatchOut(_Envelope):
    seq: int
    ops: tuple[EmittableOperation, ...]


class OpsCatchup(_Envelope):
    """``GET /transcript/ops`` 的补批响应。

    ``complete`` 为假表示要的批次已经出了日志窗口，客户端得整页重拉。
    """

    agent_id: str
    batches: tuple[OpsBatchOut, ...]
    latest_seq: int
    complete: bool


class PromptQueueOut(_Envelope):
    """``GET /prompts``：在跑的那条加排着的那些。"""

    active: Prompt | None
    queued: tuple[Prompt, ...]


__all__ = [
    "Ack",
    "ClientFrame",
    "ClientHello",
    "ClientHelloPayload",
    "OpsBatchOut",
    "OpsCatchup",
    "Ping",
    "Pong",
    "PromptQueueOut",
    "ServerFrame",
    "ServerHello",
    "ServerHelloCapabilities",
    "ServerHelloPayload",
    "Subscribe",
    "SubscribeAckPayload",
    "SubscribePayload",
    "TranscriptOps",
    "TranscriptPage",
    "TranscriptReset",
    "Unsubscribe",
    "UnsubscribePayload",
]
