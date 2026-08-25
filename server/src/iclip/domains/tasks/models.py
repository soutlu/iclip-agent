"""创作需求单的领域模型。

一张需求单是一份被记录在案的视频创作要求：谁提的、要什么、什么时候要、走到哪一步。
它是**全公司都看得见的工作队列**，不是私人物品——所以这里没有「属主」，只有「创建
者」。

创作输入本身在 [schemas.py](schemas.py)：那一套定义同时是 wire 形状与入库形状，不在
这里再写一遍。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

from iclip.domains.tasks.schemas import TaskBrief, TaskStyle

TaskStatus = Literal["draft", "published", "confirmed", "withdrawn"]

STATUS_DRAFT: Final = "draft"
"""还在写。只有创建者看得见的那部分权利：随便改、可以删。"""
STATUS_PUBLISHED: Final = "published"
"""已下发。创作输入从这一刻起冻结（见 ``schemas.PLANNER_FIELDS``）。"""
STATUS_CONFIRMED: Final = "confirmed"
"""策划师已接单。可以据此开工。"""
STATUS_WITHDRAWN: Final = "withdrawn"
"""已撤回。终态，改不动也删不掉——它是发生过的事实。"""

ACTIVE_STATUSES: Final = frozenset({STATUS_PUBLISHED, STATUS_CONFIRMED})
"""下发之后、还没撤回：这两个状态下的需求单才能被拿去开工。"""

TASK_STATUSES: Final = (STATUS_DRAFT, STATUS_PUBLISHED, STATUS_CONFIRMED, STATUS_WITHDRAWN)


@dataclass(frozen=True, slots=True)
class Task:
    """一张需求单的持久事实行。"""

    id: uuid.UUID
    title: str
    status: TaskStatus
    priority: int
    deadline: datetime | None
    """什么时候要。草稿可以先空着；一旦下发就必须有（数据库上也有一条 CHECK 守着）。"""
    creator_user_id: uuid.UUID
    style: TaskStyle
    """下单那天主款长什么样。创建时冻结，之后没有任何写入路径能改它。"""
    brief: TaskBrief
    created_at: datetime
    updated_at: datetime


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
