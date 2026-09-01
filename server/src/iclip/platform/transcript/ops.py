"""transcript 的线上形状：kimi code 协议的实体与操作，逐字段照抄。

字段名一律 camelCase，``model_dump(by_alias=True, exclude_none=True)`` 出来的就是线上
那一份，不再翻译一道。

本模块不认识 ``pydantic_ai``：WS 与 REST 那一侧也要用这些形状，而它们在围栏另一侧。

协议共 14 种操作，这里只放我们会发的那 10 种（见 ``TranscriptOperation``）。少发不破坏
兼容——客户端的 reducer 认全部 14 种，我们哪天有了后台任务与待办再补上就行。

**id 必须能被推导出来，不能由到达次序决定。**

实时那条路从事件流产出操作，历史那条路从消息历史现推，两条路产出的 id 必须逐字相同，
否则同一段对话在刷新前后会变形。所以编号一律取自这几件确定的事实：

- 轮序号 = 按消息里的 ``run_id`` 分组、组间按组内最早那条消息的时刻排（1 起）
- 步序号 = 这次 run 里 ``ModelResponse`` 的次序（1 起）
- 块序号 = 该次响应里正文块与思考块的次序（1 起，工具块不占号）
- 工具块 id = ``<步 id>.<toolCallId>``，不参与块序号

按「谁先到就给谁下一个号」编的话，一次模型重试或一个乱序事件就会让两条路永久分叉。
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

TOOL_STATE_BY_OUTCOME: dict[str, Literal["done", "error"]] = {
    "success": "done",
    "failed": "error",
    "denied": "error",
    "interrupted": "error",
}
"""工具返回的结局 → 卡片状态。协议只有三态，没成功的一律 error。

放在这里而不是各自一份：实时那条路与历史那条路都要用它，各留一份迟早会漂。
"""

MAIN_AGENT_ID = "main"
"""主 agent 的 id。协议按 agent 分 transcript，我们当前只产出这一个。"""


def utf16_len(text: str) -> int:
    """按 UTF-16 code unit 数长度。

    ``offset`` 的单位由协议定死是 UTF-16（客户端 reducer 是 TypeScript，量的是
    ``String.length``）。Python 的 ``len()`` 数的是 code point，一个 emoji 差 1。

    用错了不会报错：客户端会发现追加位置对不上，报缺口、整页重拉、重拉回来还是对不上，
    表现为无限刷新，而日志里什么都看不见。所有算 ``offset`` 和块内文字长度的地方都必须
    走这个函数。
    """

    return len(text.encode("utf-16-le")) // 2


_F_ORDINAL = re.compile(r"\.f(\d+)$")


def next_frame_ordinal(frame_ids: Iterable[str]) -> int:
    """这一步里下一个正文块/思考块该用的号。

    实时那条路与历史那条路共用这一个函数：两边编号只要有一处不一样，同一个块就有了两个 id，
    刷新前后界面会变形。

    不能拿块的个数当号：工具块不占 f 号（它的 id 是 ``<步 id>.<toolCallId>``），一步里只要
    调过工具，个数就比号大。
    """

    highest = 0
    for frame_id in frame_ids:
        found = _F_ORDINAL.search(frame_id)
        if found is not None:
            highest = max(highest, int(found.group(1)))
    return highest + 1


class _Wire(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


# --- 块 ---------------------------------------------------------------------


class TextFrame(_Wire):
    kind: Literal["text"] = "text"
    frame_id: str
    role: Literal["assistant", "user"]
    text: str
    attachment_ids: tuple[str, ...] | None = None
    prompt_ids: tuple[str, ...] | None = None


class ThinkingFrame(_Wire):
    kind: Literal["thinking"] = "thinking"
    frame_id: str
    text: str


class ToolFrame(_Wire):
    kind: Literal["tool"] = "tool"
    frame_id: str
    tool_call_id: str
    name: str
    state: Literal["running", "done", "error"]
    input: Any | None = None
    output: Any | None = None
    display: Any | None = None
    """这张卡怎么画由服务端说了算（协议里是一个封闭的 kind 联合）。客户端不认工具名。"""
    error: str | None = None
    approval_id: str | None = None


class NoticeFrame(_Wire):
    kind: Literal["notice"] = "notice"
    frame_id: str
    level: Literal["error", "warning", "info"]
    source: str | None = None
    message: str
    detail: Any | None = None


TranscriptFrame = Annotated[
    TextFrame | ThinkingFrame | ToolFrame | NoticeFrame, Field(discriminator="kind")
]


# --- 轮与步 -----------------------------------------------------------------


class TurnOrigin(_Wire):
    kind: Literal["user", "cron", "task", "hook", "compaction", "side", "other"]


class TurnUsage(_Wire):
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_tokens: int | None = None
    cost: float | None = None


class StepUsage(_Wire):
    input_other: int
    output: int
    input_cache_read: int
    input_cache_creation: int


class TurnHeader(_Wire):
    """一轮的头部。``steps`` 不在这里——步是单独的操作发的。"""

    kind: Literal["turn"] = "turn"
    turn_id: str
    ordinal: int
    state: Literal["queued", "running", "completed", "failed", "cancelled"]
    origin: TurnOrigin
    prompt: str | None = None
    attachment_ids: tuple[str, ...] | None = None
    started_at: str | None = None
    ended_at: str | None = None
    usage: TurnUsage | None = None
    duration_ms: int | None = None
    error: str | None = None


class StepHeader(_Wire):
    kind: Literal["step"] = "step"
    step_id: str
    turn_id: str
    ordinal: int
    state: Literal["running", "completed", "interrupted", "failed"]
    started_at: str | None = None
    ended_at: str | None = None
    usage: StepUsage | None = None
    finish_reason: str | None = None
    end_reason: str | None = None
    end_message: str | None = None


class TranscriptStep(StepHeader):
    """带上块的完整一步。``GET /transcript`` 的分页与快照里用这一份，操作里用光头部那份。"""

    frames: tuple[TranscriptFrame, ...] = ()


class TranscriptTurn(TurnHeader):
    """带上步的完整一轮。"""

    steps: tuple[TranscriptStep, ...] = ()


# --- 全局实体 ---------------------------------------------------------------


class Interaction(_Wire):
    """待人回应的审批或提问。``request`` / ``response`` 的形状由发起方决定。"""

    interaction_id: str
    interaction_kind: Literal["approval", "question"]
    tool_call_id: str | None = None
    state: Literal["pending", "approved", "rejected", "cancelled", "answered", "dismissed"]
    request: Any | None = None
    response: Any | None = None


class AttachmentSource(_Wire):
    kind: Literal["url", "file", "session_media"]
    url: str | None = None
    file_id: str | None = None


class Attachment(_Wire):
    attachment_id: str
    media_type: str
    name: str | None = None
    size: int | None = None
    source: AttachmentSource | None = None
    placeholder: str | None = None


class TextContent(_Wire):
    type: Literal["text"] = "text"
    text: str


class ImageContent(_Wire):
    type: Literal["image"] = "image"
    source: AttachmentSource


class VideoContent(_Wire):
    type: Literal["video"] = "video"
    source: AttachmentSource


PromptContent = Annotated[TextContent | ImageContent | VideoContent, Field(discriminator="type")]
"""一条用户消息的组成部分。

协议的联合里还有工具调用、工具返回、思考三种，那些是**模型侧**消息的部分，不会出现在用户
发上来的东西里；图片与视频的来源也只收 ``url`` 与 ``sessionMedia`` 两种（``base64`` 与本机
``path`` 是桌面端的形态）。收窄的是入口，出去的形状没有变。
"""


class Prompt(_Wire):
    """用户消息的服务端记录。客户端的乐观气泡第一层认领就是按 ``promptId`` 查这张表。"""

    prompt_id: str
    status: Literal["running", "queued", "blocked", "completed", "failed", "aborted"]
    user_message_id: str | None = None
    content: tuple[PromptContent, ...] | None = None
    created_at: str
    finished_at: str | None = None
    steered_at: str | None = None


class AgentStatusMeta(_Wire):
    context_tokens: int | None = Field(default=None, ge=0)
    max_context_tokens: int | None = Field(default=None, gt=0)
    context_usage: float | None = Field(default=None, ge=0, le=1)


def agent_context_status(context_tokens: int, max_context_tokens: int) -> AgentStatusMeta:
    """Pydantic AI 的上下文读数 → Kimi agent meta。"""

    return AgentStatusMeta(
        context_tokens=context_tokens,
        max_context_tokens=max_context_tokens,
        context_usage=min(1, context_tokens / max_context_tokens),
    )


class TranscriptMeta(_Wire):
    activity: Literal["idle", "turn", "disposing", "unknown"] | None = None
    agent: AgentStatusMeta | None = None


# --- 快照 -------------------------------------------------------------------


class TranscriptSnapshot(_Wire):
    """``transcript.reset`` 带的那一份。

    ``items`` 恒为空、``has_more_older`` 恒为真：协议把历史整个交给 REST 分页，推送这条
    路只送增量。剩下几个数组是全局实体，它们不分页，每次都全量带上。
    """

    items: tuple[Any, ...] = ()
    tasks: tuple[Any, ...] = ()
    interactions: tuple[Interaction, ...] = ()
    attachments: tuple[Attachment, ...] = ()
    todos: tuple[Any, ...] = ()
    prompts: tuple[Prompt, ...] = ()
    meta: TranscriptMeta = TranscriptMeta()
    has_more_older: bool = True


# --- 操作 -------------------------------------------------------------------


class FrameTarget(_Wire):
    type: Literal["frame"] = "frame"
    turn_id: str
    step_id: str
    frame_id: str


class ResetOp(_Wire):
    op: Literal["reset"] = "reset"
    agent_id: str
    snapshot: TranscriptSnapshot


class TurnUpsertOp(_Wire):
    op: Literal["turn.upsert"] = "turn.upsert"
    turn: TurnHeader


class StepUpsertOp(_Wire):
    op: Literal["step.upsert"] = "step.upsert"
    turn_id: str
    step: StepHeader


class FrameUpsertOp(_Wire):
    op: Literal["frame.upsert"] = "frame.upsert"
    turn_id: str
    step_id: str
    frame: TranscriptFrame


class AppendOp(_Wire):
    """往某个块的尾巴追加文字。``offset`` 的单位是 UTF-16，见 ``utf16_len``。"""

    op: Literal["append"] = "append"
    target: FrameTarget
    offset: int = Field(ge=0)
    text: str


class InteractionUpsertOp(_Wire):
    op: Literal["interaction.upsert"] = "interaction.upsert"
    interaction: Interaction


class AttachmentUpsertOp(_Wire):
    op: Literal["attachment.upsert"] = "attachment.upsert"
    attachment: Attachment


class PromptUpsertOp(_Wire):
    op: Literal["prompt.upsert"] = "prompt.upsert"
    prompt: Prompt


class MetaMergeOp(_Wire):
    op: Literal["meta.merge"] = "meta.merge"
    meta: TranscriptMeta


class ItemsRemoveOp(_Wire):
    op: Literal["items.remove"] = "items.remove"
    ids: tuple[str, ...]


EmittableOperation = Annotated[
    TurnUpsertOp
    | StepUpsertOp
    | FrameUpsertOp
    | AppendOp
    | InteractionUpsertOp
    | AttachmentUpsertOp
    | PromptUpsertOp
    | MetaMergeOp
    | ItemsRemoveOp,
    Field(discriminator="op"),
]
"""投影器能产出的那些。

``reset`` 不在里面：它是「把状态整个换掉」，只有实时状态那一侧在拼给订阅者时才发得出。
让投影器在类型上就构造不出它，比在运行时拦一道可靠。
"""

TranscriptOperation = Annotated[
    ResetOp | EmittableOperation,
    Field(discriminator="op"),
]
"""线上会出现的全部操作，含 ``reset``。客户端那侧按这个解。"""


__all__ = [
    "MAIN_AGENT_ID",
    "TOOL_STATE_BY_OUTCOME",
    "AgentStatusMeta",
    "AppendOp",
    "Attachment",
    "AttachmentSource",
    "AttachmentUpsertOp",
    "EmittableOperation",
    "FrameTarget",
    "FrameUpsertOp",
    "ImageContent",
    "Interaction",
    "InteractionUpsertOp",
    "ItemsRemoveOp",
    "MetaMergeOp",
    "NoticeFrame",
    "Prompt",
    "PromptContent",
    "PromptUpsertOp",
    "ResetOp",
    "StepHeader",
    "StepUpsertOp",
    "StepUsage",
    "TextContent",
    "TextFrame",
    "ThinkingFrame",
    "ToolFrame",
    "TranscriptFrame",
    "TranscriptMeta",
    "TranscriptOperation",
    "TranscriptSnapshot",
    "TranscriptStep",
    "TranscriptTurn",
    "TurnHeader",
    "TurnOrigin",
    "TurnUpsertOp",
    "TurnUsage",
    "VideoContent",
    "agent_context_status",
    "next_frame_ordinal",
    "utf16_len",
]
