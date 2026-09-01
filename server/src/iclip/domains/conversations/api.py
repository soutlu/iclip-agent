"""对话的 HTTP 面。

十四个端点：开一段、侧栏拓扑、任务区翻页、合集内翻页、搜自己的、治理者查全部、列出某
张单下我的尝试、读历史、列工作区文件、读工作区文件、改名、换合集、挂需求单、删掉。读用 ``agent:read``，会改动
的用 ``agent:run``——能不能看和能不能跑本来就是两件事。

别人的对话一律 404，不返 403：那会泄露「这个 id 确实存在」。治理者例外，读得到全部
（只读，写入路径没有这个口子）。
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from iclip.domains.conversations.models import Conversation
from iclip.domains.conversations.schemas import (
    ConversationCollectionIn,
    ConversationEnvelope,
    ConversationFileContentOut,
    ConversationFileEnvelope,
    ConversationFileOut,
    ConversationFilesOut,
    ConversationIn,
    ConversationOut,
    ConversationPageOut,
    ConversationRename,
    ConversationsAuditOut,
    ConversationsPageOut,
    ConversationTaskIn,
    SidebarCollectionOut,
    SidebarOut,
    conversation_out,
)
from iclip.domains.conversations.service import ConversationPage, ConversationService
from iclip.domains.identity.public import Principal, require_permission


def create_conversations_router(service: ConversationService) -> APIRouter:
    router = APIRouter(prefix="/conversations", tags=["conversations"])

    # 每行都要带上「此刻在忙什么」，而那不在库的行上。这两个助手把「批量问一次活儿」收在一处，
    # 免得每个端点各写一遍、漏一个就有一批行谎报自己空闲。
    def _out(conversation: Conversation) -> ConversationOut:
        return conversation_out(
            conversation, service.activities([conversation.id])[conversation.id]
        )

    def _outs(items: Sequence[Conversation]) -> list[ConversationOut]:
        activities = service.activities([item.id for item in items])
        return [conversation_out(item, activities[item.id]) for item in items]

    def _page_out(page: ConversationPage) -> ConversationPageOut:
        return ConversationPageOut(items=_outs(page.items), next_cursor=page.next_cursor)

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
            collection_id=body.collection_id,
        )
        return ConversationEnvelope(conversation=_out(conversation))

    @router.get("", response_model=SidebarOut)
    async def read_sidebar(
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
    ) -> SidebarOut:
        """侧栏拓扑：我的合集（各带最近几段对话）加上没归类的对话。

        一次返回而不是「先列合集再按合集列对话」：侧栏是一屏里的一个整体，分两次查
        会让两半在不同时刻的库状态上拼出来。
        """

        groups = await service.sidebar(principal)
        return SidebarOut(
            collections=[
                SidebarCollectionOut(
                    id=info.id,
                    name=info.name,
                    updated_at=info.updated_at,
                    conversation_count=total,
                    page=_page_out(page),
                )
                for info, total, page in groups
            ],
            ungrouped_count=await service.ungrouped_count(principal),
            ungrouped=_page_out(await service.ungrouped(principal)),
        )

    @router.get("/ungrouped", response_model=ConversationPageOut)
    async def list_ungrouped(
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
        cursor: str | None = None,
    ) -> ConversationPageOut:
        """侧栏「任务」区往下滑：接着上一页给。``cursor`` 原样回传响应里的 ``nextCursor``。"""

        return _page_out(await service.ungrouped(principal, cursor=cursor))

    @router.get("/by-collection/{collection_id}", response_model=ConversationPageOut)
    async def list_collection_conversations(
        collection_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
        cursor: str | None = None,
    ) -> ConversationPageOut:
        """某个合集里的对话，翻页口径同上。

        不存在的合集、别人的合集，都给一页空的——与「这个合集是空的」同一个结果。
        """

        return _page_out(await service.in_collection(principal, collection_id, cursor=cursor))

    @router.get("/search", response_model=ConversationsPageOut)
    async def search_conversations(
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        q: Annotated[str | None, Query(max_length=200)] = None,
    ) -> ConversationsPageOut:
        """按标题搜自己的对话，最近活动的排前面。筛选在库里做，搜得到全部历史。"""

        found = await service.search(principal, limit=limit, title_query=q)
        return ConversationsPageOut(items=_outs(found))

    @router.get("/audit", response_model=ConversationsAuditOut)
    async def audit_conversations(
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
        owner_user_id: Annotated[uuid.UUID | None, Query(alias="ownerUserId")] = None,
        task_id: Annotated[uuid.UUID | None, Query(alias="taskId")] = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        cursor: str | None = None,
    ) -> ConversationsAuditOut:
        """治理者查全平台的对话：按人、按单、按时间段筛，最近活动的排前面。

        没有 ``users:manage`` 就 403。``since`` / ``until`` 作用在「最近活动」那个时刻上。
        """

        found, next_cursor = await service.audit(
            principal,
            owner_user_id=owner_user_id,
            task_id=task_id,
            since=since,
            until=until,
            limit=limit,
            cursor=cursor,
        )
        return ConversationsAuditOut(items=_outs(found), next_cursor=next_cursor)

    @router.get("/by-task/{task_id}", response_model=ConversationsPageOut)
    async def list_task_attempts(
        task_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("agent:read"))],
    ) -> ConversationsPageOut:
        """列出自己在这张需求单下的尝试，按开始时间正序。

        路径写成 ``/conversations/by-task/{id}`` 而不是 ``/tasks/{id}/conversations``：
        这是对话这一侧的查询，只看得到自己的那几段——挂在需求单下面会让人以为看到的是
        全部。查别人的走 ``/conversations/audit?taskId=``。
        """

        found = await service.list_for_task(principal, task_id)
        return ConversationsPageOut(items=_outs(found))

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

    @router.patch("/{conversation_id}", response_model=ConversationEnvelope)
    async def rename_conversation(
        conversation_id: uuid.UUID,
        body: ConversationRename,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> ConversationEnvelope:
        conversation = await service.rename(principal, conversation_id, title=body.title)
        return ConversationEnvelope(conversation=_out(conversation))

    @router.put("/{conversation_id}/collection", response_model=ConversationEnvelope)
    async def set_conversation_collection(
        conversation_id: uuid.UUID,
        body: ConversationCollectionIn,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> ConversationEnvelope:
        conversation = await service.set_collection(
            principal, conversation_id, collection_id=body.collection_id
        )
        return ConversationEnvelope(conversation=_out(conversation))

    @router.put("/{conversation_id}/task", response_model=ConversationEnvelope)
    async def set_conversation_task(
        conversation_id: uuid.UUID,
        body: ConversationTaskIn,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> ConversationEnvelope:
        conversation = await service.set_task(principal, conversation_id, task_id=body.task_id)
        return ConversationEnvelope(conversation=_out(conversation))

    @router.delete("/{conversation_id}", status_code=204)
    async def delete_conversation(
        conversation_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> Response:
        await service.delete(principal, conversation_id)
        return Response(status_code=204)

    return router


__all__ = ["create_conversations_router"]
