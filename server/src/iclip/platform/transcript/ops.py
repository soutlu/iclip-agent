"""transcript 实体与操作，使用 camelCase 别名序列化；metadata 为本仓扩展字段。

实时与历史投影必须生成相同 id，编号不依赖事件到达顺序：
- 同一 prompt 的全部 run 合为一轮，按组内最早消息时间排序，从 1 编号。
- 步骤按轮内 ModelResponse 顺序编号，跨 run 连续。
- 正文与思考块共享从 1 开始的块编号，工具块不占号。
- 工具块 id 为 <stepId>.<toolCallId>。
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

TOOL_STATE_BY_OUTCOME: dict[str, Literal["done", "error"]] = {
    "success": "done",
    "failed": "error",
    "denied": "error",
    "interrupted": "error",
}
"""工具结果到卡片终态的统一映射；非成功结果均为 error。"""

MAIN_AGENT_ID = "main"
"""当前唯一产出 transcript 的主 agent 标识。"""

COMPACTION_NOTICE = "对话已压缩"
"""实时与历史投影共用的压缩提示文案。"""

APPROVAL_ID_PREFIX = "apr_"
"""审批交互 id 前缀，与 toolCallId 一一对应。"""


def utf16_len(text: str) -> int:
    """按 UTF-16 code unit 计数，与客户端 String.length 及追加 offset 一致。

    Python len 按码点计数，不能用于包含 emoji 的协议偏移。
    """

    return len(text.encode("utf-16-le")) // 2


_F_ORDINAL = re.compile(r"\.f(\d+)$")


def next_frame_ordinal(frame_ids: Iterable[str]) -> int:
    """返回下一正文或思考块编号；工具块使用 toolCallId，不计入 f 序号。"""

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


class AgentRef(_Wire):
    agent_id: str
    role: Literal["child", "member"] | None = None


class TextFrame(_Wire):
    kind: Literal["text"] = "text"
    frame_id: str
    role: Literal["assistant", "user"]
    text: str
    content: tuple[PromptContent, ...] | None = None
    """用户原始图文 parts；助手文本不使用此字段。"""
    prompt_ids: tuple[str, ...] | None = None

    @model_validator(mode="after")
    def _user_block_carries_content(self) -> TextFrame:
        """用户块需保留 parts，避免仅有 text 时丢失图片及图文顺序。"""

        if self.role == "user" and self.content is None:
            raise ValueError(f"用户块 {self.frame_id} 没带 content")
        return self


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
    """模型收到的工具返回内容；界面结果见 metadata。"""
    display: Any | None = None
    """服务端提供的 display，客户端按 kind 渲染。"""
    view: str | None = None
    """结果渲染器；未指定时使用 generic。"""
    metadata: Any | None = None
    """界面使用的 ToolReturn.metadata，不发送给模型。"""
    error: str | None = None
    approval_id: str | None = None
    agent_refs: tuple[AgentRef, ...] | None = None
    """这次调用派出的子代理。"""


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


class TranscriptTask(_Wire):
    """一件后台活儿。本系统只产出 ``subagent``：一次 delegate_task 一条。"""

    task_id: str
    kind: Literal["shell", "subagent", "tool", "other"]
    state: Literal["running", "completed", "failed", "timed_out", "killed", "lost"]
    detached: bool
    description: str | None = None
    agent_id: str | None = None
    output_tail: str = ""
    started_at: str | None = None
    ended_at: str | None = None
    result_summary: str | None = None
    error: str | None = None
    state_reason: str | None = None
    usage: StepUsage | None = None
    model: str | None = None
    thinking_effort: str | None = None


class AgentDescriptor(_Wire):
    agent_id: str
    type: Literal["main", "sub", "independent"] | None = None
    parent_agent_id: str | None = None
    label: str | None = None
    created_at: str | None = None
    disposed_at: str | None = None


def agents_from_tasks(tasks: Iterable[TranscriptTask]) -> tuple[AgentDescriptor, ...]:
    """主 agent 加每个子代理各一条；实时与历史共用这一个函数，两条路的名册才对得上。"""

    return (
        AgentDescriptor(agent_id=MAIN_AGENT_ID, type="main"),
        *(
            AgentDescriptor(
                agent_id=task.agent_id,
                type="sub",
                parent_agent_id=MAIN_AGENT_ID,
                label=task.description,
                created_at=task.started_at,
            )
            for task in tasks
            if task.kind == "subagent" and task.agent_id is not None
        ),
    )


class TurnHeader(_Wire):
    """一轮的头部。``steps`` 不在这里——步是单独的操作发的。"""

    kind: Literal["turn"] = "turn"
    turn_id: str
    ordinal: int
    state: Literal["queued", "running", "completed", "failed", "cancelled"]
    origin: TurnOrigin
    content: tuple[PromptContent, ...]
    """发起本轮的用户原始 parts。"""
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
"""用户输入仅包含文字、图片和视频，媒体来源限定为 url 或 sessionMedia。

工具调用、工具返回和思考属于模型消息；base64 与本地 path 不接受为服务端用户输入。
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


class TranscriptSnapshot(_Wire):
    """``transcript.reset`` 带的那一份。

    ``items`` 恒为空、``has_more_older`` 恒为真：协议把历史整个交给 REST 分页，推送这条
    路只送增量。剩下几个数组是全局实体，它们不分页，每次都全量带上。
    """

    items: tuple[Any, ...] = ()
    tasks: tuple[TranscriptTask, ...] = ()
    interactions: tuple[Interaction, ...] = ()
    todos: tuple[Any, ...] = ()
    prompts: tuple[Prompt, ...] = ()
    meta: TranscriptMeta = TranscriptMeta()
    has_more_older: bool = True


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


class TaskUpsertOp(_Wire):
    op: Literal["task.upsert"] = "task.upsert"
    task: TranscriptTask


class InteractionUpsertOp(_Wire):
    op: Literal["interaction.upsert"] = "interaction.upsert"
    interaction: Interaction


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
    | TaskUpsertOp
    | InteractionUpsertOp
    | PromptUpsertOp
    | MetaMergeOp
    | ItemsRemoveOp,
    Field(discriminator="op"),
]
"""投影器可生成的操作，不含仅由实时状态构造的 reset。"""

TranscriptOperation = Annotated[
    ResetOp | EmittableOperation,
    Field(discriminator="op"),
]
"""客户端可接收的操作联合，包含 reset。"""


__all__ = [
    "APPROVAL_ID_PREFIX",
    "MAIN_AGENT_ID",
    "TOOL_STATE_BY_OUTCOME",
    "AgentDescriptor",
    "AgentRef",
    "AgentStatusMeta",
    "AppendOp",
    "AttachmentSource",
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
    "TaskUpsertOp",
    "TextContent",
    "TextFrame",
    "ThinkingFrame",
    "ToolFrame",
    "TranscriptFrame",
    "TranscriptMeta",
    "TranscriptOperation",
    "TranscriptSnapshot",
    "TranscriptStep",
    "TranscriptTask",
    "TranscriptTurn",
    "TurnHeader",
    "TurnOrigin",
    "TurnUpsertOp",
    "TurnUsage",
    "VideoContent",
    "agent_context_status",
    "agents_from_tasks",
    "next_frame_ordinal",
    "utf16_len",
]
