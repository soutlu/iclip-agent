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
    """使用 Any 隔离 Web 框架类型。"""

    service: TaskService


def build_tasks_module(repo: TaskRepository) -> TasksModule:
    """需求单持久化明确提供的创作输入，不依赖产品库或对象存储。"""

    service = TaskService(repo)
    return TasksModule(routers=(create_tasks_router(service),), service=service)


__all__ = ["TasksModule", "build_tasks_module"]
