"""需求单持久化端口，读取不按属主隔离。

状态条件与写入须原子执行，避免校验后状态被并发改变；条件不匹配返回 None 或 False，
由服务层转换为冲突。修改权限由服务层校验。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Protocol

from iclip.domains.tasks.models import Task, TaskStatus
from iclip.domains.tasks.schemas import TaskBrief


class TaskRepository(Protocol):
    """``iclip.tasks`` 的数据访问。"""

    async def create(self, task: Task) -> Task:
        """插入一行新需求单，返回落库后的整行。"""
        ...

    async def get(self, task_id: uuid.UUID) -> Task:
        """按 id 读一行；没有这一行就抛 ``NotFound``。"""
        ...

    async def list_recent(
        self,
        *,
        status: TaskStatus | None = None,
        assignee_user_id: uuid.UUID | None = None,
        limit: int,
    ) -> tuple[Task, ...]:
        """按最近修改时间倒序返回需求单，可按状态和认领人筛选。"""
        ...

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
        """整体更新可变字段；状态与 expect 不符时返回 None。接口不接受创建时冻结的款号快照。"""
        ...

    async def publish(self, task_id: uuid.UUID) -> Task | None:
        """原子校验 draft 状态和未过期的期限后发布，时间比较使用数据库时钟。"""
        ...

    async def confirm(self, task_id: uuid.UUID, *, user_id: uuid.UUID) -> Task | None:
        """在同一事务中幂等添加认领人，并将 published 转为 confirmed。

        已 confirmed 的需求单仅追加认领人；其他状态不写入并返回 None。"""
        ...

    async def set_status(
        self, task_id: uuid.UUID, *, expect: TaskStatus, status: TaskStatus
    ) -> Task | None:
        """条件更新状态；当前状态与 expect 不符时返回 None。"""
        ...

    async def delete(self, task_id: uuid.UUID, *, expect: TaskStatus) -> bool:
        """条件删除；当前状态与 expect 不符时返回 False。"""
        ...


__all__ = ["TaskRepository"]
