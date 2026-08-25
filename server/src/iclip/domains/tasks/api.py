"""创作需求单的 HTTP 面。

读用 ``tasks:read``，一切会改动的用 ``tasks:write``——权限词汇表里早就留好了这两个
名字，不发明新的。端点级的权限只管「能不能做这类事」；「这一张能不能由你来改」是
``service.py`` 的判断。

需求单人人可见，所以这里不存在「别人的返 404」那套写法：不存在才 404，看得见但不让
改是 403。
"""

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
        _: Annotated[Principal, Depends(require_permission("tasks:read"))],
        status: TaskStatus | None = None,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
    ) -> TasksPageOut:
        found = await service.list_recent(status=status, limit=limit)
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
        _: Annotated[Principal, Depends(require_permission("tasks:write"))],
    ) -> TaskEnvelope:
        return TaskEnvelope(task=task_out(await service.confirm(task_id)))

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
