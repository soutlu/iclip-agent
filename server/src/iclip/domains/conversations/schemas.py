"""对话的 wire 形状。字段名按跨端约定用 camelCase。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final

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
    """新建一段对话。不给名字就用默认名。"""

    agent_id: Annotated[str, Field(min_length=1, max_length=MAX_AGENT_ID_CHARS)]
    title: Title | None = None


class ConversationRename(CamelModel):
    title: Title


class ConversationOut(CamelModel):
    id: uuid.UUID
    agent_id: str
    title: str
    last_run_id: str | None
    created_at: datetime
    updated_at: datetime


class ConversationEnvelope(CamelModel):
    conversation: ConversationOut


class ConversationsPageOut(CamelModel):
    items: list[ConversationOut]


def conversation_out(conversation: Conversation) -> ConversationOut:
    """领域行 → wire 形状。属主不外发：调用方看到的本来就只有自己的对话。"""

    return ConversationOut(
        id=conversation.id,
        agent_id=conversation.agent_id,
        title=conversation.title,
        last_run_id=conversation.last_run_id,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
    )


__all__ = [
    "DEFAULT_TITLE",
    "MAX_AGENT_ID_CHARS",
    "MAX_TITLE_CHARS",
    "ConversationEnvelope",
    "ConversationIn",
    "ConversationOut",
    "ConversationRename",
    "ConversationsPageOut",
    "conversation_out",
]
