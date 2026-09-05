"""创作需求单领域模型。需求单全公司可见，创建者不构成读取边界。

认领关系存于 task_assignees，支持多人认领；创作输入和款号快照的类型统一定义在 schemas.py。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Final, Literal

from iclip.domains.tasks.schemas import TaskBrief, TaskStyle

TaskStatus = Literal["draft", "published", "confirmed", "withdrawn"]

STATUS_DRAFT: Final = "draft"
STATUS_PUBLISHED: Final = "published"
"""发布后冻结创作输入，允许补充的字段见 schemas.PLANNER_FIELDS。"""
STATUS_CONFIRMED: Final = "confirmed"
STATUS_WITHDRAWN: Final = "withdrawn"
"""撤回是终态，禁止修改和删除。"""

ACTIVE_STATUSES: Final = frozenset({STATUS_PUBLISHED, STATUS_CONFIRMED})
"""允许开工的需求单状态。"""

TASK_STATUSES: Final = (STATUS_DRAFT, STATUS_PUBLISHED, STATUS_CONFIRMED, STATUS_WITHDRAWN)


@dataclass(frozen=True, slots=True)
class Task:
    """一张需求单的持久事实行。"""

    id: uuid.UUID
    title: str
    status: TaskStatus
    priority: int
    deadline: datetime | None
    """草稿可不设期限；发布后必须存在，由数据库 CHECK 约束保证。"""
    creator_user_id: uuid.UUID
    style: TaskStyle
    """创建时冻结的主款快照，更新路径不可修改。"""
    brief: TaskBrief
    created_at: datetime
    updated_at: datetime
    assignee_user_ids: tuple[uuid.UUID, ...] = field(default_factory=tuple)
    """task_assignees 表中认领关系的读取投影。"""


__all__ = [
    "ACTIVE_STATUSES",
    "STATUS_CONFIRMED",
    "STATUS_DRAFT",
    "STATUS_PUBLISHED",
    "STATUS_WITHDRAWN",
    "TASK_STATUSES",
    "Task",
    "TaskStatus",
]
