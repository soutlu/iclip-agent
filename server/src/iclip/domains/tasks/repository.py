"""创作需求单的持久化端口。

**读没有属主参数**：需求单是全公司的工作队列，谁有 ``tasks:read`` 谁就看得见全部。
「能不能改」是另一回事，那一层判断在 ``service.py``。

**每个写方法都带一个 ``expect``**：调用方读到这一行时它是什么状态，就把那个状态交回
来当写入条件。判断和写入之间隔着一次 await，那当口别人可能刚把它发布或撤回；不带这
个条件的话，一次「改草稿」会落到一张已经下发的需求单上。对不上就一行也改不到，方法
返回 ``None``（或 ``False``），由 ``service.py`` 翻译成冲突。
"""

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
        self, *, status: TaskStatus | None = None, limit: int
    ) -> tuple[Task, ...]:
        """按最近改动倒序列出需求单；``status`` 给了就只看那一档。"""
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
        """整体覆盖一行。状态不再是 ``expect`` 就什么都不做并返回 ``None``。"""
        ...

    async def publish(self, task_id: uuid.UUID) -> Task | None:
        """``draft`` → ``published``，并在同一条语句里守住「期限必须还没到」。

        期限的比较必须发生在数据库里：这是本仓「所有时刻一律取数据库的钟」的一处落
        点。应用进程的钟快了几秒，同一张需求单在这台机器上发得出去、在另一台上发不
        出去。
        """
        ...

    async def set_status(
        self, task_id: uuid.UUID, *, expect: TaskStatus, status: TaskStatus
    ) -> Task | None:
        """流转状态。当前状态不是 ``expect`` 就什么都不做并返回 ``None``。"""
        ...

    async def delete(self, task_id: uuid.UUID, *, expect: TaskStatus) -> bool:
        """删掉一行；状态对不上就什么都不做并返回 ``False``。"""
        ...


__all__ = ["TaskRepository"]
