"""tasks 测试替身与构造器。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from iclip.common.errors import NotFound
from iclip.domains.tasks.models import STATUS_DRAFT, Task, TaskStatus
from iclip.domains.tasks.schemas import TaskBrief


def make_brief(**overrides: Any) -> TaskBrief:
    fields: dict[str, Any] = {"theme": "秋冬新品", "requirement_description": "三十秒的上身效果"}
    fields.update(overrides)
    return TaskBrief(**fields)


def future(days: int = 7) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)


def make_task(
    *,
    status: TaskStatus = STATUS_DRAFT,
    creator_user_id: uuid.UUID | None = None,
    brief: TaskBrief | None = None,
    deadline: datetime | None = None,
    title: str = "秋冬新品短视频",
    priority: int = 0,
) -> Task:
    now = datetime.now(UTC)
    return Task(
        id=uuid.uuid4(),
        title=title,
        status=status,
        priority=priority,
        deadline=deadline
        if deadline is not None
        else (None if status == STATUS_DRAFT else future()),
        creator_user_id=creator_user_id or uuid.uuid4(),
        brief=brief or make_brief(),
        created_at=now,
        updated_at=now,
    )


class InMemoryTaskRepository:
    """``TaskRepository`` 的内存替身。

    写方法照样守 ``expect``：状态守卫是这个端口的语义，替身少守一条，单测就测不出
    「读到写之间被人插了一手」这类回归。发布时的期限比较在真实实现里由数据库的钟做，
    这里用进程的钟近似——单测验的是分支走向，时钟一致性由真库那层的用例守。
    """

    def __init__(self, tasks: list[Task] | None = None) -> None:
        self.tasks: dict[uuid.UUID, Task] = {task.id: task for task in tasks or []}

    async def create(self, task: Task) -> Task:
        self.tasks[task.id] = task
        return task

    async def get(self, task_id: uuid.UUID) -> Task:
        found = self.tasks.get(task_id)
        if found is None:
            raise NotFound("没有这张需求单")
        return found

    async def list_recent(
        self, *, status: TaskStatus | None = None, limit: int
    ) -> tuple[Task, ...]:
        rows = sorted(self.tasks.values(), key=lambda task: task.updated_at, reverse=True)
        if status is not None:
            rows = [task for task in rows if task.status == status]
        return tuple(rows[:limit])

    async def save(
        self,
        task_id: uuid.UUID,
        *,
        expect: TaskStatus,
        title: str,
        priority: int,
        deadline: datetime | None,
        brief: TaskBrief,
    ) -> Task | None:
        return self._replace(
            task_id, expect, title=title, priority=priority, deadline=deadline, brief=brief
        )

    async def publish(self, task_id: uuid.UUID) -> Task | None:
        found = self.tasks.get(task_id)
        if found is None or found.status != STATUS_DRAFT:
            return None
        if found.deadline is None or found.deadline <= datetime.now(UTC):
            return None
        return self._replace(task_id, STATUS_DRAFT, status="published")

    async def set_status(
        self, task_id: uuid.UUID, *, expect: TaskStatus, status: TaskStatus
    ) -> Task | None:
        return self._replace(task_id, expect, status=status)

    async def delete(self, task_id: uuid.UUID, *, expect: TaskStatus) -> bool:
        found = self.tasks.get(task_id)
        if found is None or found.status != expect:
            return False
        del self.tasks[task_id]
        return True

    def _replace(self, task_id: uuid.UUID, expect: TaskStatus, **changes: Any) -> Task | None:
        from dataclasses import replace

        found = self.tasks.get(task_id)
        if found is None or found.status != expect:
            return None
        updated = replace(found, updated_at=datetime.now(UTC), **changes)
        self.tasks[task_id] = updated
        return updated


__all__ = ["InMemoryTaskRepository", "future", "make_brief", "make_task"]
