"""对话的 wire 形状。字段名按跨端约定用 camelCase。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Final

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.domains.conversations.models import Conversation

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


class ConversationEnvelope(CamelModel):
    conversation: ConversationOut


class ConversationsPageOut(CamelModel):
    items: list[ConversationOut]


class SidebarCollectionOut(CamelModel):
    """侧栏里的一个合集：元信息加最近几段对话。

    ``conversationCount`` 是这个合集里的全部条数，``conversations`` 只有最近几段——
    展开看更多是另一次查询的事。
    """

    id: uuid.UUID
    name: str
    updated_at: datetime
    conversation_count: int
    conversations: list[ConversationOut]


class SidebarOut(CamelModel):
    """侧栏拓扑：合集分组 + 没归类的对话。一次查询拿全，前端不再自己拼。"""

    collections: list[SidebarCollectionOut]
    ungrouped: list[ConversationOut]


class ConversationsAuditOut(CamelModel):
    """审计列表。``nextCursor`` 为空表示没有更多了。"""

    items: list[ConversationOut]
    next_cursor: str | None


class ConversationMessagesOut(CamelModel):
    """一段对话已经发生过的消息。

    ``messages`` 里是 AG-UI 官方形状的消息，字段名沿用 AG-UI 的拼写，不套这一层的
    camelCase 改写——它们要原样喂回 ``POST /agents/{agentId}/chat`` 的请求体。
    """

    messages: list[dict[str, Any]]


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


class ConversationFileEnvelope(CamelModel):
    file: ConversationFileContentOut


def conversation_out(conversation: Conversation) -> ConversationOut:
    """领域行 → wire 形状。"""

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
    )


__all__ = [
    "DEFAULT_TITLE",
    "MAX_AGENT_ID_CHARS",
    "MAX_TITLE_CHARS",
    "ConversationCollectionIn",
    "ConversationEnvelope",
    "ConversationFileContentOut",
    "ConversationFileEnvelope",
    "ConversationFileOut",
    "ConversationFilesOut",
    "ConversationIn",
    "ConversationMessagesOut",
    "ConversationOut",
    "ConversationRename",
    "ConversationTaskIn",
    "ConversationsAuditOut",
    "ConversationsPageOut",
    "SidebarCollectionOut",
    "SidebarOut",
    "conversation_out",
]
