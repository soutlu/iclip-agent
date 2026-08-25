"""对话的 HTTP 面。

五个端点：开一段、列出我的、读历史、改名、删掉。读用 ``agent:read``，会改动的用
``agent:run``——能不能看和能不能跑本来就是两件事。

别人的对话一律 404，不返 403：那会泄露「这个 id 确实存在」。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from iclip.domains.conversations.schemas import (
    ConversationEnvelope,
    ConversationIn,
    ConversationMessagesOut,
    ConversationRename,
    ConversationsPageOut,
    conversation_out,
)
from iclip.domains.conversations.service import ConversationService
from iclip.domains.identity.public import Principal, require_permission


def create_conversations_router(service: ConversationService) -> APIRouter:
    router = APIRouter(prefix="/conversations", tags=["conversations"])

    @router.post("", response_model=ConversationEnvelope, status_code=201)
    async def create_conversation(
        body: ConversationIn,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> ConversationEnvelope:
        conversation = await service.create(principal, agent_id=body.agent_id, title=body.title)
        return ConversationEnvelope(conversation=conversation_out(conversation))

    @router.get("", response_model=ConversationsPageOut)
    async def list_conversations(
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> ConversationsPageOut:
        found = await service.list_recent(principal, limit=limit)
        return ConversationsPageOut(items=[conversation_out(item) for item in found])

    @router.get("/{conversation_id}/messages", response_model=ConversationMessagesOut)
    async def read_conversation_messages(
        conversation_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
    ) -> ConversationMessagesOut:
        messages = await service.history(principal, conversation_id)
        return ConversationMessagesOut(messages=list(messages))

    @router.patch("/{conversation_id}", response_model=ConversationEnvelope)
    async def rename_conversation(
        conversation_id: uuid.UUID,
        body: ConversationRename,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> ConversationEnvelope:
        conversation = await service.rename(principal, conversation_id, title=body.title)
        return ConversationEnvelope(conversation=conversation_out(conversation))

    @router.delete("/{conversation_id}", status_code=204)
    async def delete_conversation(
        conversation_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> Response:
        await service.delete(principal, conversation_id)
        return Response(status_code=204)

    return router


__all__ = ["create_conversations_router"]
