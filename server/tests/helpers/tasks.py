"""tasks 测试替身与构造器。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.tasks.models import (
    STATUS_CONFIRMED,
    STATUS_DRAFT,
    STATUS_PUBLISHED,
    Task,
    TaskStatus,
)
from iclip.domains.tasks.schemas import TaskBrief, TaskStyle

STYLE_NO = "SBPU24001W"


def make_brief(**overrides: Any) -> TaskBrief:
    fields: dict[str, Any] = {"theme": "秋冬新品", "requirement_description": "三十秒的上身效果"}
    fields.update(overrides)
    return TaskBrief(**fields)


def make_style(**overrides: Any) -> TaskStyle:
    fields: dict[str, Any] = {
        "style_no": STYLE_NO,
        "brand": "Bruno Marc",
        "category": "高跟鞋",
        "preview_image_url": "https://cdn.example.com/task-styles/cover.jpg",
    }
    fields.update(overrides)
    return TaskStyle(**fields)


class StubStyleSnapshots:
    """``StyleSnapshots`` 的替身：认识 ``known`` 里的款，别的都当查不到。

    真身要查产品资料库再把首图搬进对象存储，那两样都不在单测的射程里；这个端口窄到
    一句话就能替掉，所以单测验的是「查不到怎么办、抄到了存哪去」的分支。
    """

    def __init__(self, known: dict[str, TaskStyle] | None = None) -> None:
        self.known = known if known is not None else {STYLE_NO: make_style()}
        self.asked: list[str] = []

    async def of(self, style_no: str) -> TaskStyle:
        self.asked.append(style_no)
        found = self.known.get(style_no)
        if found is None:
            raise ValidationFailed(f"款号 {style_no} 在产品资料里查不到")
        return found


def future(days: int = 7) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)


def make_task(
    *,
    status: TaskStatus = STATUS_DRAFT,
    creator_user_id: uuid.UUID | None = None,
    brief: TaskBrief | None = None,
    style: TaskStyle | None = None,
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
        style=style or make_style(),
        brief=brief or make_brief(),
        created_at=now,
        updated_at=now,
        assignee_user_ids=assignee_user_ids,
    )


class InMemoryTaskRepository:
    """``TaskRepository`` 的内存替身。

    写方法照样守 ``expect``：状态守卫是这个端口的语义，替身少守一条，单测就测不出
    「读到写之间被人插了一手」这类回归。发布时的期限比较在真实实现里由数据库的钟做，
    这里用进程的钟近似——单测验的是分支走向，时钟一致性由真库那层的用例守。
    """

    def __init__(self, tasks: list[Task] | None = None) -> None:
        self.tasks: dict[uuid.UUID, Task] = {task.id: task for task in tasks or []}
        self.project_ids: dict[uuid.UUID, tuple[uuid.UUID, ...]] = {}

    async def create(self, task: Task) -> Task:
        self.tasks[task.id] = task
        return task

    async def list_project_ids(self, task_id: uuid.UUID) -> tuple[uuid.UUID, ...]:
        return self.project_ids.get(task_id, ())

    async def set_project_ids(
        self, task_id: uuid.UUID, *, project_ids: tuple[uuid.UUID, ...]
    ) -> tuple[uuid.UUID, ...]:
        # 去重照真实实现来：调用方给重了不是错误，「挂两遍」和「挂一遍」是同一件事。
        # 替身不校验项目存不存在——那是外键的事，这里没有外键。
        saved = tuple(dict.fromkeys(project_ids))
        self.project_ids[task_id] = saved
        return saved

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

    async def confirm(self, task_id: uuid.UUID, *, user_id: uuid.UUID) -> Task | None:
        from dataclasses import replace

        found = self.tasks.get(task_id)
        if found is None or found.status not in (STATUS_PUBLISHED, STATUS_CONFIRMED):
            return None
        assignees = found.assignee_user_ids
        if user_id not in assignees:
            assignees = (*assignees, user_id)
        status: TaskStatus = STATUS_CONFIRMED
        updated = replace(
            found,
            status=status,
            assignee_user_ids=assignees,
            updated_at=datetime.now(UTC),
        )
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
    "StubStyleSnapshots",
    "future",
    "make_brief",
    "make_style",
    "make_task",
]
