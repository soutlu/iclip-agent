"""项目的 HTTP 面。

五个端点：开一个、列出、读一个、改名、删掉。读用 ``projects:read``，会改动的用
``projects:write``。

项目人人可见，所以这里不存在「别人的返 404」那套：不存在才是 404，看得见但不让删是
403（不变量 9，口径同需求单）。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.projects.schemas import (
    ProjectEnvelope,
    ProjectIn,
    ProjectsPageOut,
    project_out,
)
from iclip.domains.projects.service import ProjectService


def create_projects_router(service: ProjectService) -> APIRouter:
    router = APIRouter(prefix="/projects", tags=["projects"])

    @router.post("", response_model=ProjectEnvelope, status_code=201)
    async def create_project(
        body: ProjectIn,
        principal: Annotated[Principal, Depends(require_permission("projects:write"))],
    ) -> ProjectEnvelope:
        project = await service.create(principal, name=body.name)
        return ProjectEnvelope(project=project_out(project))

    @router.get("", response_model=ProjectsPageOut)
    async def list_projects(
        _principal: Annotated[Principal, Depends(require_permission("projects:read"))],
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> ProjectsPageOut:
        found = await service.list_recent(limit=limit)
        return ProjectsPageOut(items=[project_out(item) for item in found])

    @router.get("/{project_id}", response_model=ProjectEnvelope)
    async def read_project(
        project_id: uuid.UUID,
        _principal: Annotated[Principal, Depends(require_permission("projects:read"))],
    ) -> ProjectEnvelope:
        project = await service.get(project_id)
        return ProjectEnvelope(project=project_out(project))

    @router.patch("/{project_id}", response_model=ProjectEnvelope)
    async def rename_project(
        project_id: uuid.UUID,
        body: ProjectIn,
        _principal: Annotated[Principal, Depends(require_permission("projects:write"))],
    ) -> ProjectEnvelope:
        project = await service.rename(project_id, name=body.name)
        return ProjectEnvelope(project=project_out(project))

    @router.delete("/{project_id}", status_code=204)
    async def delete_project(
        project_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("projects:write"))],
    ) -> Response:
        await service.delete(principal, project_id)
        return Response(status_code=204)

    return router


__all__ = ["create_projects_router"]
