"""项目的用例层：建口袋、改名、删口袋。

两条规则：

1. **项目人人可见。** 跟需求单一个口径——``projects:read`` 就够，没有「不可见」这种
   情况。所以判断只在「能不能改」这一侧，看得见但不让改就是 403（不变量 9）。
2. **改名是公事，删除是私事。** 谁都会往项目里放东西，所以改名任何持
   ``projects:write`` 的人都能做。删除收紧到建它的人（或治理者）：删掉一个项目会把
   别人会话上的归属一并置空，影响面出了发起人自己那一摊。
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from iclip.common.errors import PermissionDenied
from iclip.domains.identity.public import Principal
from iclip.domains.projects.models import Project
from iclip.domains.projects.repository import ProjectRepository
from iclip.domains.projects.schemas import MAX_LIST_LIMIT

MANAGE_PERMISSION = "users:manage"


class ProjectService:
    """建项目、读项目、改它、删它。"""

    def __init__(self, repo: ProjectRepository) -> None:
        self._repo = repo

    async def create(self, principal: Principal, *, name: str) -> Project:
        """开一个新项目，归到发起人名下。"""

        now = datetime.now(UTC)
        return await self._repo.create(
            Project(
                id=uuid.uuid4(),
                creator_user_id=principal.user_id,
                name=name,
                created_at=now,
                updated_at=now,
            )
        )

    async def get(self, project_id: uuid.UUID) -> Project:
        """读一个项目。人人可见，所以不带主体。"""

        return await self._repo.get(project_id)

    async def list_recent(self, *, limit: int) -> tuple[Project, ...]:
        """列出项目，最近改动的排前面。"""

        return await self._repo.list_recent(limit=min(limit, MAX_LIST_LIMIT))

    async def rename(self, project_id: uuid.UUID, *, name: str) -> Project:
        """改名。公事，持 ``projects:write`` 就能做，所以不挑人。"""

        return await self._repo.rename(project_id, name=name)

    async def delete(self, principal: Principal, project_id: uuid.UUID) -> None:
        """删项目。只有建它的人或治理者能删。"""

        project = await self._repo.get(project_id)
        if principal.user_id != project.creator_user_id and not principal.has(MANAGE_PERMISSION):
            raise PermissionDenied("只有开这个项目的人能删掉它")
        await self._repo.delete(project_id)


__all__ = ["MANAGE_PERMISSION", "ProjectService"]
