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
    EmittableOperation,
    Interaction,
    Prompt,
    PromptContent,
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


class ResetPayload(_Envelope):
    """``has_more_older`` 在 snapshot 外面，协议就是这么放的。"""

    agent_id: str
    snapshot: TranscriptSnapshot
    has_more_older: bool = True
    seq: int


class OpsPayload(_Envelope):
    """一批操作。``seq`` 是这一批的批次号，每 agent 连续。"""

    agent_id: str
    ops: tuple[EmittableOperation, ...]
    seq: int


class _Event(_Envelope):
    """事件信封。

    ``session_id`` 说这一帧是哪段对话的：一条连接管多段，客户端按它分流，少了就不知道该给谁。
    信封上还有一个 ``seq``，它与 ``payload.seq`` **不是一回事**——那个是 transcript 的批次号
    （有意义、要记账），这个只是这条连接上的第几帧，进程重启即归零，客户端不拿它做任何事。
    """

    seq: int
    session_id: str
    timestamp: str


class TranscriptReset(_Event):
    """订阅时的第一帧。"""

    type: Literal["transcript.reset"] = "transcript.reset"
    payload: ResetPayload


class TranscriptOps(_Event):
    type: Literal["transcript.ops"] = "transcript.ops"
    payload: OpsPayload


class SessionMetaPayload(_Envelope):
    session_id: str
    title: str


class SessionMetaUpdated(_Envelope):
    """某段对话的标题变了。

    **这一帧不看订阅，发给每一条连着的连接**（协议里它属于全局事件那一类）。侧栏列着几十段
    对话却一段都没订，按订阅发的话它永远收不到改名。
    """

    type: Literal["session.meta.updated"] = "session.meta.updated"
    payload: SessionMetaPayload


class SessionWorkPayload(_Envelope):
    busy: bool
    pending_interaction: Literal["none", "approval", "question"]
    last_turn_reason: Literal["completed", "failed", "aborted"] | None = None


class SessionWorkChanged(_Envelope):
    """某段对话「在忙什么」变了。

    与 ``session.meta.updated`` 同一类：**不看订阅，发给这个人连着的每一条连接**。侧栏列着几十段
    对话却一段都没订，按订阅发的话它永远收不到角标。

    ``session_id`` 在信封上而不在 payload 里，与协议其余 ``event.*`` 一致。

    **易失**：这一帧不进任何日志，掉了就是掉了。所以列表行上也带着同一份事实（见
    ``ConversationOut.activity``），断线重连后重拉列表即可对齐——帧只负责「不必等下一次重拉」。
    """

    type: Literal["event.session.work_changed"] = "event.session.work_changed"
    session_id: str
    payload: SessionWorkPayload


class FsChangeEntry(_Envelope):
    path: str
    change: Literal["created", "modified", "deleted"]
    kind: Literal["file", "directory"] = "file"


class FsChangePayload(_Envelope):
    changes: tuple[FsChangeEntry, ...]
    coalesced_window_ms: int = 0
    """kimi 那侧是文件系统 watcher，一个时间窗合并成一帧；我们在写入口直接发，窗口是零。"""


class FsChanged(_Event):
    """某段对话的工作区文件变了，照 kimi 的 ``event.fs.changed``。

    **只发给用 ``watch_fs_add`` 订了这段对话这个路径的连接**，不是全局帧：文件变动只有正看着
    它的那一页关心。帧上不带版本与写入者——收到就重读那个文件，版本在文件上；是不是自己刚写
    的由客户端记自己写回时拿到的版本号来判。

    **易失**：掉了就是掉了。文件列表接口才是事实源，这一帧只负责「不必等下一次重拉」。
    """

    type: Literal["event.fs.changed"] = "event.fs.changed"
    payload: FsChangePayload


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


class PingPayload(_Envelope):
    nonce: str


class Ping(_Envelope):
    """心跳。客户端照着 ``nonce`` 原样回一帧 pong。"""

    type: Literal["ping"] = "ping"
    payload: PingPayload


ServerFrame = Annotated[
    ServerHello
    | TranscriptReset
    | TranscriptOps
    | SessionMetaUpdated
    | SessionWorkChanged
    | FsChanged
    | Ack
    | Ping,
    Field(discriminator="type"),
]


# --- WS：客户端发给服务端 -----------------------------------------------------


class SubscribePayload(_Envelope):
    """订阅一段对话。``transcript`` 是每个 agent 要哪一档，我们只产出 ``delta``。

    ``transcript_since`` 是客户端手上的水位，按 agent 给；给了就补那之后的批次。

    协议里还有一帧 ``client_hello``，用来一次报上全部订阅与各自的 cursor。我们不收它：一条
    连接管几段对话就发几帧 ``subscribe_v2``，各带自己的水位，重连时照样。
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


class WatchFsPayload(_Envelope):
    """订一段对话里的几个路径。路径是目录时 ``recursive`` 决定只看直接子项还是整棵。"""

    session_id: str
    paths: tuple[str, ...]
    recursive: bool = False


class WatchFsAdd(_Envelope):
    type: Literal["watch_fs_add"] = "watch_fs_add"
    id: str
    payload: WatchFsPayload


class WatchFsRemove(_Envelope):
    type: Literal["watch_fs_remove"] = "watch_fs_remove"
    id: str
    payload: WatchFsPayload


class WatchFsAckPayload(_Envelope):
    watched_paths: tuple[str, ...] = ()
    current_count: int = 0


class Pong(_Envelope):
    type: Literal["pong"] = "pong"
    payload: PingPayload | None = None


ClientFrame = Annotated[
    Subscribe | Unsubscribe | WatchFsAdd | WatchFsRemove | Pong,
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
    todos: tuple[Any, ...] = ()
    prompts: tuple[Prompt, ...] = ()
    meta: TranscriptMeta = TranscriptMeta()
    title: str = ""
    """这段对话叫什么。放在信封顶层而不是 ``meta`` 里：``meta`` 的形状归协议管，客户端拿
    照抄来的 zod 校验它，多一个字段会被静默丢掉。首屏靠它显示标题，之后的改名走
    ``session.meta.updated``。"""
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


# --- REST 请求体 --------------------------------------------------------------
#
# 请求体的字段名同样照协议原样（snake_case）。整个 transcript 面只有一条规矩：逐字照抄，
# 不按仓内的 camelCase 习惯翻译——一半照抄一半翻译，写客户端的人得记两套。


class PromptSubmission(_Envelope):
    """``POST /prompts`` 的请求体。

    ``prompt_id`` 由客户端铸：它得在服务端答复回来之前就用这个 id 把自己的乐观气泡挂上，
    而且重发同一个 id 不会多起一次运行。
    """

    prompt_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")
    content: tuple[PromptContent, ...] = Field(min_length=1)


class SteerRequest(_Envelope):
    prompt_ids: tuple[str, ...] = Field(min_length=1)


class ApprovalRequest(_Envelope):
    approved: bool


__all__ = [
    "Ack",
    "ApprovalRequest",
    "ClientFrame",
    "FsChangeEntry",
    "FsChangePayload",
    "FsChanged",
    "OpsBatchOut",
    "OpsCatchup",
    "OpsPayload",
    "Ping",
    "PingPayload",
    "Pong",
    "PromptQueueOut",
    "PromptSubmission",
    "ResetPayload",
    "ServerFrame",
    "ServerHello",
    "ServerHelloCapabilities",
    "ServerHelloPayload",
    "SessionMetaPayload",
    "SessionMetaUpdated",
    "SessionWorkChanged",
    "SessionWorkPayload",
    "SteerRequest",
    "Subscribe",
    "SubscribeAckPayload",
    "SubscribePayload",
    "TranscriptOps",
    "TranscriptPage",
    "TranscriptReset",
    "Unsubscribe",
    "UnsubscribePayload",
    "WatchFsAckPayload",
    "WatchFsAdd",
    "WatchFsPayload",
    "WatchFsRemove",
]
