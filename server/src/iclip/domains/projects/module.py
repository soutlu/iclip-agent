"""projects 装配单元：组合根只调用 ``build_projects_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.projects.api import create_projects_router
from iclip.domains.projects.repository import ProjectRepository
from iclip.domains.projects.service import ProjectService


@dataclass(frozen=True)
class ProjectsModule:
    routers: tuple[Any, ...]
    """路由的类型写 ``Any``（同 identity / conversations）：装配单元不该把 web 框架拖进这一环。"""

    service: ProjectService


def build_projects_module(repo: ProjectRepository) -> ProjectsModule:
    """装配 projects。仓储由组合根给（同 conversations 的套路）。"""

    service = ProjectService(repo)
    return ProjectsModule(routers=(create_projects_router(service),), service=service)


__all__ = ["ProjectsModule", "build_projects_module"]
