"""对话的 HTTP 面。

九个端点：开一段、列出我的、列出某张单下我的尝试、读历史、列工作区文件、读工作区文件、
改名、换项目、删掉。读用 ``agent:read``，会改动的用 ``agent:run``——能不能看和能不能跑本来
就是两件事。

别人的对话一律 404，不返 403：那会泄露「这个 id 确实存在」。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from iclip.domains.conversations.schemas import (
    ConversationEnvelope,
    ConversationFileContentOut,
    ConversationFileEnvelope,
    ConversationFileOut,
    ConversationFilesOut,
    ConversationIn,
    ConversationMessagesOut,
    ConversationProjectIn,
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
        conversation = await service.create(
            principal,
            agent_id=body.agent_id,
            title=body.title,
            task_id=body.task_id,
            project_id=body.project_id,
        )
        return ConversationEnvelope(conversation=conversation_out(conversation))

    @router.get("", response_model=ConversationsPageOut)
    async def list_conversations(
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        q: Annotated[str | None, Query(max_length=200)] = None,
    ) -> ConversationsPageOut:
        found = await service.list_recent(principal, limit=limit, title_query=q)
        return ConversationsPageOut(items=[conversation_out(item) for item in found])

    @router.get("/{conversation_id}/messages", response_model=ConversationMessagesOut)
    async def read_conversation_messages(
        conversation_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
    ) -> ConversationMessagesOut:
        messages = await service.history(principal, conversation_id)
        return ConversationMessagesOut(messages=list(messages))

    @router.get("/{conversation_id}/workspace/files", response_model=ConversationFilesOut)
    async def list_conversation_files(
        conversation_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
    ) -> ConversationFilesOut:
        found = await service.files(principal, conversation_id)
        return ConversationFilesOut(
            files=[
                ConversationFileOut(
                    path=entry.path,
                    size_bytes=entry.size_bytes,
                    version=entry.version,
                    updated_at=entry.updated_at,
                )
                for entry in found
            ]
        )

    @router.get("/{conversation_id}/workspace/file", response_model=ConversationFileEnvelope)
    async def read_conversation_file(
        conversation_id: uuid.UUID,
        path: Annotated[str, Query(min_length=1)],
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
    ) -> ConversationFileEnvelope:
        """路径放在查询串里而不是路径段里：文件路径自己就带 ``/``。"""

        found = await service.file(principal, conversation_id, path=path)
        return ConversationFileEnvelope(
            file=ConversationFileContentOut(
                path=found.path, content=found.content, version=found.version
            )
        )

    @router.get("/by-task/{task_id}", response_model=ConversationsPageOut)
    async def list_task_attempts(
        task_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
    ) -> ConversationsPageOut:
        """列出自己在这张需求单下的尝试，按开始时间正序。

        路径写成 ``/conversations/by-task/{id}`` 而不是 ``/tasks/{id}/conversations``：
        这是对话这一侧的查询，只看得到自己的那几段——挂在需求单下面会让人以为看到的是
        全部。
        """

        found = await service.list_for_task(principal, task_id)
        return ConversationsPageOut(items=[conversation_out(item) for item in found])

    @router.patch("/{conversation_id}", response_model=ConversationEnvelope)
    async def rename_conversation(
        conversation_id: uuid.UUID,
        body: ConversationRename,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> ConversationEnvelope:
        conversation = await service.rename(principal, conversation_id, title=body.title)
        return ConversationEnvelope(conversation=conversation_out(conversation))

    @router.put("/{conversation_id}/project", response_model=ConversationEnvelope)
    async def set_conversation_project(
        conversation_id: uuid.UUID,
        body: ConversationProjectIn,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> ConversationEnvelope:
        conversation = await service.set_project(
            principal, conversation_id, project_id=body.project_id
        )
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
