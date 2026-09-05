"""对话的 wire 形状。字段名按跨端约定用 camelCase。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.domains.conversations.models import Conversation, ConversationActivity

MAX_TITLE_CHARS: Final = 200
MAX_AGENT_ID_CHARS: Final = 128
DEFAULT_TITLE: Final = "新对话"


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


Title = Annotated[str, Field(min_length=1, max_length=MAX_TITLE_CHARS)]


class ConversationIn(CamelModel):
    """新建一段对话。不给名字就用默认名。

    两处归属都可以先不给，之后再挂（见 ``ConversationTaskIn`` 与
    ``ConversationCollectionIn``）。
    """

    agent_id: Annotated[str, Field(min_length=1, max_length=MAX_AGENT_ID_CHARS)]
    title: Title | None = None
    task_id: uuid.UUID | None = None
    collection_id: uuid.UUID | None = None


class ConversationRename(CamelModel):
    title: Title


class ConversationCollectionIn(CamelModel):
    """把这段对话放进某个合集，或者拿出来（给 ``null``）。

    单独一个端点而不是并进改名那个 PATCH：那样「没给这个字段」和「要清空它」在 JSON
    里长得一样，分不出来。
    """

    collection_id: uuid.UUID | None


class ConversationTaskIn(CamelModel):
    """把这段对话记在某张需求单下，或者摘掉（给 ``null``）。理由同上，单独一个端点。"""

    task_id: uuid.UUID | None


class ConversationActivityOut(CamelModel):
    """这段对话此刻在忙什么。侧栏据此画角标。

    嵌套一层而不是把字段平铺到行上：这一组事实还会长，平铺的话每加一个都要在行上再开一个
    顶层字段。
    """

    busy: bool
    pending_interaction: Literal["none", "approval", "question"]
    last_turn_reason: Literal["completed", "failed", "aborted"] | None = None


class ConversationOut(CamelModel):
    id: uuid.UUID
    owner_user_id: uuid.UUID
    """谁的对话。治理者的审计视图要看得出这一点，所以对外发。"""
    agent_id: str
    title: str
    last_run_id: str | None
    task_id: uuid.UUID | None
    collection_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    activity: ConversationActivityOut


class ConversationEnvelope(CamelModel):
    conversation: ConversationOut


class ConversationsPageOut(CamelModel):
    items: list[ConversationOut]


class ConversationPageOut(CamelModel):
    """一页对话。``nextCursor`` 为空即没有更多了；往下滑加载更多时原样回传它。"""

    items: list[ConversationOut]
    next_cursor: str | None


class SidebarCollectionOut(CamelModel):
    """侧栏里的一个合集：元信息、里面一共几段，加第一页对话。

    ``conversationCount`` 是全部条数，``page`` 只有第一页——往下滑要更多是另一次查询。
    """

    id: uuid.UUID
    name: str
    updated_at: datetime
    conversation_count: int
    page: ConversationPageOut


class SidebarOut(CamelModel):
    """侧栏拓扑：合集分组 + 没归类的对话。首屏一次拿全，前端不再自己拼。

    两个数字都是真总数（不是这一页几条）：``ungroupedCount`` 与每个合集的
    ``conversationCount``。
    """

    collections: list[SidebarCollectionOut]
    ungrouped_count: int
    ungrouped: ConversationPageOut


class ConversationsAuditOut(CamelModel):
    """审计列表。``nextCursor`` 为空表示没有更多了。"""

    items: list[ConversationOut]
    next_cursor: str | None


class ConversationFileOut(CamelModel):
    """agent 在这段对话里写下的一个文件的元信息。``version`` 变了内容才变，前端据此决定要不要重读。"""

    path: str
    size_bytes: int
    version: int
    updated_at: datetime


class ConversationFilesOut(CamelModel):
    files: list[ConversationFileOut]


class ConversationFileContentOut(CamelModel):
    path: str
    content: str
    version: int


class ConversationFileWriteIn(CamelModel):
    """整份覆盖工作区里的一个文件。

    ``expectedVersion`` 是读到那一份的版本号：agent 与用户会同时写同一份文件，对不上
    就是 409，让调用方重读再决定，而不是把别人刚写的盖掉。
    """

    path: Annotated[str, Field(min_length=1)]
    content: str
    expected_version: int


class ConversationFileEnvelope(CamelModel):
    file: ConversationFileContentOut


def conversation_out(conversation: Conversation, activity: ConversationActivity) -> ConversationOut:
    """合并对话记录与引擎提供的活动投影，转换为响应模型。"""

    return ConversationOut(
        id=conversation.id,
        owner_user_id=conversation.owner_user_id,
        agent_id=conversation.agent_id,
        title=conversation.title,
        last_run_id=conversation.last_run_id,
        task_id=conversation.task_id,
        collection_id=conversation.collection_id,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        activity=ConversationActivityOut(
            busy=activity.busy,
            pending_interaction=activity.pending_interaction,
            last_turn_reason=activity.last_turn_reason,
        ),
    )


__all__ = [
    "DEFAULT_TITLE",
    "MAX_AGENT_ID_CHARS",
    "MAX_TITLE_CHARS",
    "ConversationActivityOut",
    "ConversationCollectionIn",
    "ConversationEnvelope",
    "ConversationFileContentOut",
    "ConversationFileEnvelope",
    "ConversationFileOut",
    "ConversationFileWriteIn",
    "ConversationFilesOut",
    "ConversationIn",
    "ConversationOut",
    "ConversationPageOut",
    "ConversationRename",
    "ConversationTaskIn",
    "ConversationsAuditOut",
    "ConversationsPageOut",
    "SidebarCollectionOut",
    "SidebarOut",
    "conversation_out",
]
