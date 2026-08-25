"""tasks 装配单元：组合根只调用 ``build_tasks_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.tasks.api import create_tasks_router
from iclip.domains.tasks.repository import TaskRepository
from iclip.domains.tasks.service import TaskService


@dataclass(frozen=True)
class TasksModule:
    routers: tuple[Any, ...]
    """路由的类型写 ``Any``（同 identity / conversations / generation）：装配单元不该
    把 web 框架拖进这一环。"""

    service: TaskService


def build_tasks_module(repo: TaskRepository) -> TasksModule:
    """装配 tasks。它只要一张自己的表，不依赖任何别的模块。"""

    service = TaskService(repo)
    return TasksModule(routers=(create_tasks_router(service),), service=service)


__all__ = ["TasksModule", "build_tasks_module"]
