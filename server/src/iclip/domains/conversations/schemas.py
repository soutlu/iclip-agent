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

    ``taskId`` 只在这里给：它说的是这段对话的由来，开完就定了。``projectId`` 之后还能
    换（见 ``ConversationProjectIn``）。两个都不给就是「直接开始创作」。
    """

    agent_id: Annotated[str, Field(min_length=1, max_length=MAX_AGENT_ID_CHARS)]
    title: Title | None = None
    task_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None


class ConversationRename(CamelModel):
    title: Title


class ConversationProjectIn(CamelModel):
    """把这段对话放进某个项目，或者拿出来（给 ``null``）。

    单独一个端点而不是并进改名那个 PATCH：那样「没给这个字段」和「要清空它」在 JSON
    里长得一样，分不出来。
    """

    project_id: uuid.UUID | None


class ConversationOut(CamelModel):
    id: uuid.UUID
    agent_id: str
    title: str
    last_run_id: str | None
    task_id: uuid.UUID | None
    project_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class ConversationEnvelope(CamelModel):
    conversation: ConversationOut


class ConversationsPageOut(CamelModel):
    items: list[ConversationOut]


class ConversationMessagesOut(CamelModel):
    """一段对话已经发生过的消息。

    ``messages`` 里是 AG-UI 官方形状的消息，字段名沿用 AG-UI 的拼写，不套这一层的
    camelCase 改写——它们要原样喂回 ``POST /agents/{agentId}/chat`` 的请求体。
    """

    messages: list[dict[str, Any]]


def conversation_out(conversation: Conversation) -> ConversationOut:
    """领域行 → wire 形状。属主不外发：调用方看到的本来就只有自己的对话。"""

    return ConversationOut(
        id=conversation.id,
        agent_id=conversation.agent_id,
        title=conversation.title,
        last_run_id=conversation.last_run_id,
        task_id=conversation.task_id,
        project_id=conversation.project_id,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
    )


__all__ = [
    "DEFAULT_TITLE",
    "MAX_AGENT_ID_CHARS",
    "MAX_TITLE_CHARS",
    "ConversationEnvelope",
    "ConversationIn",
    "ConversationMessagesOut",
    "ConversationOut",
    "ConversationProjectIn",
    "ConversationRename",
    "ConversationsPageOut",
    "conversation_out",
]
