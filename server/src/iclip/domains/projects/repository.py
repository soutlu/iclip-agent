"""项目的持久化端口。

不按属主过滤：项目跟需求单一个口径，全公司都看得见（``projects:read`` 就够）。所以
这里没有 ``owner`` 参数——「谁建的」只是行上的一个事实，不是查询条件。
"""

from __future__ import annotations

import uuid
from typing import Protocol

from iclip.domains.projects.models import Project


class ProjectRepository(Protocol):
    """``iclip.projects`` 的数据访问。"""

    async def create(self, project: Project) -> Project:
        """插入一行新项目，返回落库后的整行。"""
        ...

    async def get(self, project_id: uuid.UUID) -> Project:
        """按 id 读一行；不存在抛 ``NotFound``。"""
        ...

    async def list_recent(self, *, limit: int) -> tuple[Project, ...]:
        """按最近改动倒序列出项目。"""
        ...

    async def rename(self, project_id: uuid.UUID, *, name: str) -> Project:
        """改名，返回改完的整行。"""
        ...

    async def delete(self, project_id: uuid.UUID) -> None:
        """删掉这一行。已经不在了就抛 ``NotFound``。

        挂在它上面的需求单关联会跟着消失，而会话只是把归属那一列置空——口袋没了，
        东西还在。这两条都由外键写在表上，不在这一层重做。
        """
        ...


__all__ = ["ProjectRepository"]
