"""tasks 装配单元：组合根只调用 ``build_tasks_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.tasks.api import create_tasks_router
from iclip.domains.tasks.ports import StyleSnapshots
from iclip.domains.tasks.repository import TaskRepository
from iclip.domains.tasks.service import TaskService


@dataclass(frozen=True)
class TasksModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: TaskService


def build_tasks_module(repo: TaskRepository, snapshots: StyleSnapshots) -> TasksModule:
    """通过注入的 StyleSnapshots 读取产品快照，需求单域不依赖产品库或对象存储实现。"""

    service = TaskService(repo, snapshots)
    return TasksModule(routers=(create_tasks_router(service),), service=service)


__all__ = ["TasksModule", "build_tasks_module"]
