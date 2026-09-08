"""tasks 测试替身与构造器。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from iclip.common.errors import NotFound
from iclip.domains.tasks.models import (
    STATUS_CONFIRMED,
    STATUS_DRAFT,
    STATUS_PUBLISHED,
    Task,
    TaskStatus,
)
from iclip.domains.tasks.schemas import TaskInputs

STYLE_NO = "SBPU24001W"


def make_inputs(**overrides: Any) -> TaskInputs:
    fields: dict[str, Any] = {
        "product": {"style_no": STYLE_NO},
        "creative_requirement": "三十秒的上身效果",
    }
    fields.update(overrides)
    return TaskInputs(**fields)


def future(days: int = 7) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)


def make_task(
    *,
    status: TaskStatus = STATUS_DRAFT,
    creator_user_id: uuid.UUID | None = None,
    inputs: TaskInputs | None = None,
    deadline: datetime | None = None,
    title: str = "秋冬新品短视频",
    priority: int = 0,
    assignee_user_ids: tuple[uuid.UUID, ...] = (),
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
        inputs=inputs or make_inputs(),
        created_at=now,
        updated_at=now,
        assignee_user_ids=assignee_user_ids,
    )


class InMemoryTaskRepository:
    """TaskRepository 内存替身，保留 expect 状态守卫。

    期限使用进程时钟；数据库时钟的一致性由集成测试验证。
    """

    def __init__(self, tasks: list[Task] | None = None) -> None:
        self.tasks: dict[uuid.UUID, Task] = {task.id: task for task in tasks or []}

    async def create_if_absent(self, task: Task) -> tuple[Task, bool]:
        found = self.tasks.get(task.id)
        if found is not None:
            return found, False
        self.tasks[task.id] = task
        return task, True

    async def get(self, task_id: uuid.UUID) -> Task:
        found = self.tasks.get(task_id)
        if found is None:
            raise NotFound("没有这张需求单")
        return found

    async def list_recent(
        self,
        *,
        status: TaskStatus | None = None,
        assignee_user_id: uuid.UUID | None = None,
        limit: int,
    ) -> tuple[Task, ...]:
        rows = sorted(self.tasks.values(), key=lambda task: task.updated_at, reverse=True)
        if status is not None:
            rows = [task for task in rows if task.status == status]
        if assignee_user_id is not None:
            rows = [task for task in rows if assignee_user_id in task.assignee_user_ids]
        return tuple(rows[:limit])

    async def save(
        self,
        task_id: uuid.UUID,
        *,
        expect: TaskStatus,
        title: str,
        priority: int,
        deadline: datetime | None,
        inputs: TaskInputs,
    ) -> Task | None:
        return self._replace(
            task_id, expect, title=title, priority=priority, deadline=deadline, inputs=inputs
        )

    async def publish(self, task_id: uuid.UUID) -> Task | None:
        found = self.tasks.get(task_id)
        if found is None or found.status != STATUS_DRAFT:
            return None
        if found.deadline is not None and found.deadline <= datetime.now(UTC):
            return None
        return self._replace(task_id, STATUS_DRAFT, status="published")

    async def confirm(self, task_id: uuid.UUID, *, user_id: uuid.UUID) -> Task | None:
        from dataclasses import replace

        found = self.tasks.get(task_id)
        if found is None or found.status not in (STATUS_PUBLISHED, STATUS_CONFIRMED):
            return None
        assignees = found.assignee_user_ids
        if user_id not in assignees:
            assignees = (*assignees, user_id)
        updated = replace(found, status=STATUS_CONFIRMED, assignee_user_ids=assignees)
        # 仅首次确认更新需求单时间；后续认领只新增认领记录。
        if found.status == STATUS_PUBLISHED:
            updated = replace(updated, updated_at=datetime.now(UTC))
        self.tasks[task_id] = updated
        return updated

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


__all__ = [
    "STYLE_NO",
    "InMemoryTaskRepository",
    "future",
    "make_inputs",
    "make_task",
]
