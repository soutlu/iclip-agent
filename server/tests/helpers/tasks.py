"""tasks 测试替身、构造器与经 HTTP 建单的驱动。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from iclip.common.errors import NotFound
from iclip.domains.tasks.models import (
    ACTIVE_STATUSES,
    STATUS_CONFIRMED,
    STATUS_DRAFT,
    STATUS_PUBLISHED,
    Task,
    TaskCursor,
    TaskStatus,
)
from iclip.domains.tasks.schemas import TaskInputs

STYLE_NO = "SBPU24001W"


def make_inputs(**overrides: Any) -> TaskInputs:
    fields: dict[str, Any] = {
        "products": [{"style_no": STYLE_NO}],
        "creative_requirement": "三十秒的上身效果",
    }
    fields.update(overrides)
    return TaskInputs(**fields)


def future(days: int = 7) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)


URL = "/tasks"

INPUTS = {
    "products": [
        {
            "style_no": STYLE_NO,
            "name": "秋冬长靴",
            "brand": "品牌甲",
            "category": "鞋靴",
            "color_name": "黑色",
            "image_oss_urls": ["https://example.com/product.jpg"],
        },
        {
            "style_no": "SBPU24002W",
            "name": "同系列短靴",
            "brand": "品牌甲",
            "category": "鞋靴",
            "color_name": "棕色",
            "image_oss_urls": [],
        },
    ],
    "video_spec": {
        "platform": "douyin",
        "video_type": "product_showcase",
        "content_type": "short_video",
        "resolution": "1080p",
        "aspect_ratio": "9:16",
        "duration_seconds": 30,
    },
    "creative_requirement": "三十秒的上身效果",
    "reference_image_oss_urls": {
        "model": ["https://example.com/model.jpg"],
        "outfit": [],
        "prop": [],
    },
    "reference_video_oss_url": None,
}


async def create(client: httpx.AsyncClient, **body: object) -> httpx.Response:
    return await client.post(
        URL,
        json={
            "title": "秋冬新品短视频",
            "inputs": INPUTS,
            "deadline": future().isoformat(),
            **body,
        },
    )


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

    def _matching(
        self,
        status: TaskStatus | None,
        assignee_user_id: uuid.UUID | None,
        ids: Sequence[uuid.UUID] | None,
    ) -> list[Task]:
        """与真仓储同一条排序键：``(created_at, id)`` 倒序。"""

        rows = sorted(
            self.tasks.values(), key=lambda task: (task.created_at, task.id), reverse=True
        )
        if status is not None:
            rows = [task for task in rows if task.status == status]
        if assignee_user_id is not None:
            rows = [task for task in rows if assignee_user_id in task.assignee_user_ids]
        if ids is not None:
            wanted = set(ids)
            rows = [task for task in rows if task.id in wanted]
        return rows

    async def list_recent(
        self,
        *,
        status: TaskStatus | None = None,
        assignee_user_id: uuid.UUID | None = None,
        ids: Sequence[uuid.UUID] | None = None,
        limit: int,
        after: TaskCursor | None = None,
    ) -> tuple[Task, ...]:
        rows = self._matching(status, assignee_user_id, ids)
        if after is not None:
            rows = [
                task
                for task in rows
                if (task.created_at, task.id) < (after.created_at, after.task_id)
            ]
        return tuple(rows[:limit])

    async def count(
        self,
        *,
        status: TaskStatus | None = None,
        assignee_user_id: uuid.UUID | None = None,
        ids: Sequence[uuid.UUID] | None = None,
    ) -> int:
        return len(self._matching(status, assignee_user_id, ids))

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
        if found is None or found.status not in ACTIVE_STATUSES:
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
    "INPUTS",
    "STYLE_NO",
    "URL",
    "InMemoryTaskRepository",
    "create",
    "future",
    "make_inputs",
    "make_task",
]
