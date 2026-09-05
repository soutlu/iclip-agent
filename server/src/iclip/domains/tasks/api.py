"""需求单 HTTP 端点。读取使用 tasks:read，写入使用 tasks:write，状态和角色约束由服务层校验。"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.tasks.models import TaskStatus
from iclip.domains.tasks.schemas import (
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
    TaskCreateIn,
    TaskEnvelope,
    TaskIn,
    TasksPageOut,
    task_out,
)
from iclip.domains.tasks.service import TaskService


def create_tasks_router(service: TaskService) -> APIRouter:
    router = APIRouter(prefix="/tasks", tags=["tasks"])

    @router.post("", response_model=TaskEnvelope, status_code=201)
    async def create_task(
        body: TaskCreateIn,
        principal: Annotated[Principal, Depends(require_permission("tasks:write"))],
    ) -> TaskEnvelope:
        task = await service.create(principal, body)
        return TaskEnvelope(task=task_out(task))

    @router.get("", response_model=TasksPageOut)
    async def list_tasks(
        principal: Annotated[Principal, Depends(require_permission("tasks:read"))],
        status: TaskStatus | None = None,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        claimed_by: Annotated[str | None, Query(alias="claimedBy", pattern="^me$")] = None,
    ) -> TasksPageOut:
        # 「我认领的」只认 me：认领人必须从服务端身份来，不能是调用方报上来的 id。
        assignee = principal.user_id if claimed_by == "me" else None
        found = await service.list_recent(status=status, assignee_user_id=assignee, limit=limit)
        return TasksPageOut(items=[task_out(task) for task in found])

    @router.get("/{task_id}", response_model=TaskEnvelope)
    async def get_task(
        task_id: uuid.UUID,
        _: Annotated[Principal, Depends(require_permission("tasks:read"))],
    ) -> TaskEnvelope:
        return TaskEnvelope(task=task_out(await service.get(task_id)))

    @router.put("/{task_id}", response_model=TaskEnvelope)
    async def save_task(
        task_id: uuid.UUID,
        body: TaskIn,
        principal: Annotated[Principal, Depends(require_permission("tasks:write"))],
    ) -> TaskEnvelope:
        task = await service.update(principal, task_id, body)
        return TaskEnvelope(task=task_out(task))

    @router.post("/{task_id}/publish", response_model=TaskEnvelope)
    async def publish_task(
        task_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("tasks:write"))],
    ) -> TaskEnvelope:
        task = await service.publish(principal, task_id)
        return TaskEnvelope(task=task_out(task))

    @router.post("/{task_id}/confirm", response_model=TaskEnvelope)
    async def confirm_task(
        task_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("tasks:write"))],
    ) -> TaskEnvelope:
        return TaskEnvelope(task=task_out(await service.confirm(principal, task_id)))

    @router.post("/{task_id}/withdraw", response_model=TaskEnvelope)
    async def withdraw_task(
        task_id: uuid.UUID,
        _: Annotated[Principal, Depends(require_permission("tasks:write"))],
    ) -> TaskEnvelope:
        return TaskEnvelope(task=task_out(await service.withdraw(task_id)))

    @router.delete("/{task_id}", status_code=204)
    async def delete_task(
        task_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("tasks:write"))],
    ) -> Response:
        await service.delete(principal, task_id)
        return Response(status_code=204)

    return router


__all__ = ["create_tasks_router"]
