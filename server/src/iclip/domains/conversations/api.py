"""对话 HTTP 端点。对话读取使用 agent:read，Agent 目录和写操作使用 agent:run。

不可见对话返回 404；治理者可跨属主读取，写入仍限属主。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, Response

from iclip.domains.conversations.models import Conversation, ConversationActivity
from iclip.domains.conversations.schemas import (
    ConversationAgentOut,
    ConversationAgentsOut,
    ConversationCollectionIn,
    ConversationCompletionIn,
    ConversationEnvelope,
    ConversationFileContentOut,
    ConversationFileEnvelope,
    ConversationFileOut,
    ConversationFilesOut,
    ConversationFileWriteIn,
    ConversationForkIn,
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
from iclip.domains.conversations.service import (
    ConversationPage,
    ConversationService,
    DeletedFilter,
    ListAgents,
    ListState,
)
from iclip.domains.identity.public import (
    MANAGE_PERMISSION,
    ActAs,
    Principal,
    require_permission,
)
from iclip.platform.paging import DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT


def create_conversations_router(
    service: ConversationService, *, agents: ListAgents, act_as: ActAs
) -> APIRouter:
    router = APIRouter(prefix="/conversations", tags=["conversations"])

    # 活动状态独立于对话记录，在序列化前批量读取。
    async def _out(conversation: Conversation) -> ConversationOut:
        activities = await service.activities([conversation.id])
        return conversation_out(conversation, activities[conversation.id])

    async def _outs(items: Sequence[Conversation]) -> list[ConversationOut]:
        activities = await service.activities([item.id for item in items])
        return [conversation_out(item, activities[item.id]) for item in items]

    def _page_out_with(
        page: ConversationPage, activities: Mapping[uuid.UUID, ConversationActivity]
    ) -> ConversationPageOut:
        return ConversationPageOut(
            items=[conversation_out(item, activities[item.id]) for item in page.items],
            next_cursor=page.next_cursor,
        )

    async def _page_out(page: ConversationPage) -> ConversationPageOut:
        return _page_out_with(page, await service.activities([item.id for item in page.items]))

    @router.get("/agents", response_model=ConversationAgentsOut)
    async def list_agents(
        _: Annotated[Principal, require_permission("agent:run")],
    ) -> ConversationAgentsOut:
        """读取当前装配的顶层 Agent 名册，按声明顺序返回；热重载后下次请求即见新目录。"""

        directory = agents()
        return ConversationAgentsOut(
            items=[ConversationAgentOut(id=entry.id, name=entry.name) for entry in directory.items],
            default=directory.default,
        )

    @router.post("", response_model=ConversationEnvelope, status_code=201)
    async def create_conversation(
        body: ConversationIn,
        principal: Annotated[Principal, require_permission("agent:run")],
        response: Response,
    ) -> ConversationEnvelope:
        """开一段对话。带 ``id`` 重发时不新建，答复已有那一段并把状态码降为 200。"""

        principal = await act_as(principal, body.user_name)
        conversation, created = await service.create(
            principal,
            agent_id=body.agent_id,
            conversation_id=body.id,
            title=body.title,
            task_id=body.task_id,
            collection_id=body.collection_id,
        )
        if not created:
            response.status_code = 200
        return ConversationEnvelope(conversation=await _out(conversation))

    @router.post("/{conversation_id}:fork", response_model=ConversationEnvelope, status_code=201)
    async def fork_conversation(
        conversation_id: uuid.UUID,
        body: ConversationForkIn,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> ConversationEnvelope:
        """从看得见的某段对话的第 ``turn`` 轮分叉出一段自己的对话，源对话不变。

        源看不见是 404，正在跑是 409，轮号越界是 422。副本的 id 由服务端铸。
        """

        conversation = await service.fork(
            principal,
            conversation_id,
            turn=body.turn,
            title=body.title,
            agent_id=body.agent_id,
            collection_id=body.collection_id,
        )
        return ConversationEnvelope(conversation=await _out(conversation))

    @router.get("", response_model=SidebarOut)
    async def read_sidebar(
        principal: Annotated[Principal, require_permission("agent:read")],
        state: ListState = "all",
    ) -> SidebarOut:
        """侧栏拓扑：我的合集（各带最近几段对话）加上没归类的对话。

        一次返回而不是「先列合集再按合集列对话」：侧栏是一屏里的一个整体，分两次查
        会让两半在不同时刻的库状态上拼出来。

        ``state`` 四值：``open`` / ``done`` 看属主标没标收尾，``running`` 是此刻在跑，
        ``all`` 不筛；两个数字按同一个筛选算。
        """

        view = await service.sidebar(principal, state=state)
        return SidebarOut(
            collections=[
                SidebarCollectionOut(
                    id=group.collection.id,
                    name=group.collection.name,
                    updated_at=group.collection.updated_at,
                    conversation_count=group.total,
                    page=_page_out_with(group.page, view.activities),
                )
                for group in view.groups
            ],
            ungrouped_count=view.ungrouped_total,
            ungrouped=_page_out_with(view.ungrouped, view.activities),
        )

    @router.get("/ungrouped", response_model=ConversationPageOut)
    async def list_ungrouped(
        principal: Annotated[Principal, require_permission("agent:read")],
        cursor: str | None = None,
        state: ListState = "all",
    ) -> ConversationPageOut:
        """侧栏「任务」区往下滑：接着上一页给。``cursor`` 原样回传响应里的 ``nextCursor``。"""

        return await _page_out(await service.ungrouped(principal, cursor=cursor, state=state))

    @router.get("/by-collection/{collection_id}", response_model=ConversationPageOut)
    async def list_collection_conversations(
        collection_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("agent:read")],
        cursor: str | None = None,
        state: ListState = "all",
    ) -> ConversationPageOut:
        """某个合集里的对话，翻页口径同上。

        不存在的合集、别人的合集，都给一页空的——与「这个合集是空的」同一个结果。
        """

        return await _page_out(
            await service.in_collection(principal, collection_id, cursor=cursor, state=state)
        )

    @router.get("/search", response_model=ConversationsPageOut)
    async def search_conversations(
        principal: Annotated[Principal, require_permission("agent:read")],
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        q: Annotated[str | None, Query(max_length=200)] = None,
    ) -> ConversationsPageOut:
        """按标题搜自己的对话，最近建的排前面。筛选在库里做，搜得到全部历史。"""

        found = await service.search(principal, limit=limit, title_query=q)
        return ConversationsPageOut(items=await _outs(found))

    @router.get("/audit", response_model=ConversationsAuditOut)
    async def audit_conversations(
        _: Annotated[Principal, require_permission("agent:read", MANAGE_PERMISSION)],
        owner_user_id: Annotated[uuid.UUID | None, Query(alias="ownerUserId")] = None,
        task_id: Annotated[uuid.UUID | None, Query(alias="taskId")] = None,
        since: datetime | None = None,
        until: datetime | None = None,
        state: ListState = "all",
        deleted: DeletedFilter = "live",
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> ConversationsAuditOut:
        """治理者查全平台的对话：按人、按单、按时间段、按状态、按删没删筛，最近建的排前面。

        ``since`` / ``until`` 作用在建立时刻上，与排序同一列——
        同页报表按各指标自己的事件时刻分期，两边不是同一批对话；
        ``state`` 的四值与侧栏同一口径；``deleted`` 缺省只看活着的，``deleted`` 只看属主删掉的，
        ``all`` 都看。``total`` 与 ``runningTotal`` 是真总数，不随翻页变。
        """

        page = await service.audit(
            owner_user_id=owner_user_id,
            task_id=task_id,
            since=since,
            until=until,
            state=state,
            deleted=deleted,
            limit=limit,
            cursor=cursor,
        )
        return ConversationsAuditOut(
            items=await _outs(page.items),
            next_cursor=page.next_cursor,
            total=page.total,
            running_total=page.running_total,
        )

    @router.get("/by-task/{task_id}", response_model=ConversationsPageOut)
    async def list_task_attempts(
        task_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("agent:read")],
    ) -> ConversationsPageOut:
        """列出自己在这张需求单下的尝试，最后一次排在最前。

        路径写成 ``/conversations/by-task/{id}`` 而不是 ``/tasks/{id}/conversations``：
        这是对话这一侧的查询，只看得到自己的那几段——挂在需求单下面会让人以为看到的是
        全部。查别人的走 ``/conversations/audit?taskId=``。
        """

        found = await service.list_for_task(principal, task_id)
        return ConversationsPageOut(items=await _outs(found))

    @router.get("/{conversation_id}/workspace/files", response_model=ConversationFilesOut)
    async def list_conversation_files(
        conversation_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("agent:read")],
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
        principal: Annotated[Principal, require_permission("agent:read")],
    ) -> ConversationFileEnvelope:
        """路径放在查询串里而不是路径段里：文件路径自己就带 ``/``。"""

        found = await service.file(principal, conversation_id, path=path)
        return ConversationFileEnvelope(
            file=ConversationFileContentOut(
                path=found.path, content=found.content, version=found.version
            )
        )

    @router.put("/{conversation_id}/workspace/file", response_model=ConversationFileEnvelope)
    async def write_conversation_file(
        conversation_id: uuid.UUID,
        body: ConversationFileWriteIn,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> ConversationFileEnvelope:
        """整份覆盖一个工作区文件。路径在体里，与读那一侧的查询串是同一个字符串。

        版本对不上 409，文件本身不合它那条路径的规矩 422（消息原样给出来）。
        """

        written = await service.write_file(
            principal,
            conversation_id,
            path=body.path,
            content=body.content,
            expected_version=body.expected_version,
        )
        return ConversationFileEnvelope(
            file=ConversationFileContentOut(
                path=written.path, content=written.content, version=written.version
            )
        )

    @router.patch("/{conversation_id}", response_model=ConversationEnvelope)
    async def rename_conversation(
        conversation_id: uuid.UUID,
        body: ConversationRename,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> ConversationEnvelope:
        conversation = await service.rename(principal, conversation_id, title=body.title)
        return ConversationEnvelope(conversation=await _out(conversation))

    @router.put("/{conversation_id}/collection", response_model=ConversationEnvelope)
    async def set_conversation_collection(
        conversation_id: uuid.UUID,
        body: ConversationCollectionIn,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> ConversationEnvelope:
        conversation = await service.set_collection(
            principal, conversation_id, collection_id=body.collection_id
        )
        return ConversationEnvelope(conversation=await _out(conversation))

    @router.put("/{conversation_id}/task", response_model=ConversationEnvelope)
    async def set_conversation_task(
        conversation_id: uuid.UUID,
        body: ConversationTaskIn,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> ConversationEnvelope:
        conversation = await service.set_task(principal, conversation_id, task_id=body.task_id)
        return ConversationEnvelope(conversation=await _out(conversation))

    @router.put("/{conversation_id}/completion", response_model=ConversationEnvelope)
    async def set_conversation_completion(
        conversation_id: uuid.UUID,
        body: ConversationCompletionIn,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> ConversationEnvelope:
        """属主标记这段对话收尾了，或取消标记。机器不会自己标。"""

        conversation = await service.set_completed(
            principal, conversation_id, completed=body.completed
        )
        return ConversationEnvelope(conversation=await _out(conversation))

    @router.delete("/{conversation_id}", status_code=204)
    async def delete_conversation(
        conversation_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> Response:
        await service.delete(principal, conversation_id)
        return Response(status_code=204)

    return router


__all__ = ["create_conversations_router"]
