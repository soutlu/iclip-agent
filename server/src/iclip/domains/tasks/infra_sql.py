"""``iclip.tasks`` 的 Postgres 后端。DDL 归 Alembic，这里不建表。

**所有时刻都取数据库的时钟**（``now()``）：创建与改动时刻是这样，发布时「期限还没
到」那一句比较也是这样。多台应用服务器的钟差几秒，同一张需求单就会在这台机器上发得
出去、在另一台上发不出去。

**没有属主过滤**：需求单是全公司的工作队列（见 ``repository.py``），所以这里不用
``platform/db`` 的行级归属原语——那是给私人资源用的。
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Final

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    Uuid,
    delete,
    func,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine.row import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.tasks.models import (
    STATUS_DRAFT,
    STATUS_PUBLISHED,
    TASK_STATUSES,
    Task,
    TaskStatus,
)
from iclip.domains.tasks.schemas import (
    TaskBrief,
    brief_from_payload,
    brief_to_payload,
    style_from_payload,
    style_to_payload,
)

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

_STATUS_LIST = ", ".join(f"'{status}'" for status in TASK_STATUSES)

tasks_table = Table(
    "tasks",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("title", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("priority", Integer, nullable=False),
    Column("deadline", DateTime(timezone=True), nullable=True),
    # 不级联删除：一张下发过的需求单是公司账本上的事实，不该跟着提它的那个账号一起
    # 消失（同 generation_jobs 里「哪把 key 干的」那条审计事实）。账号目前只停用不
    # 删除，所以 restrict 不会挡住任何正常路径；真去删就该响亮地失败。
    Column(
        "creator_user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="restrict"),
        nullable=False,
    ),
    # 下单那天主款的样子。不塞进 brief：那是需求方填的，这是服务端抄的，可改性不同。
    Column("style", JSONB, nullable=False),
    Column("brief", JSONB, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    CheckConstraint(f"status IN ({_STATUS_LIST})", name="tasks_status_check"),
    # 草稿可以先不定期限；一旦下发，「什么时候要」就必须写着。
    CheckConstraint(
        f"status = '{STATUS_DRAFT}' OR deadline IS NOT NULL", name="tasks_deadline_check"
    ),
    CheckConstraint("jsonb_typeof(brief) = 'object'", name="tasks_brief_object_check"),
    CheckConstraint("jsonb_typeof(style) = 'object'", name="tasks_style_object_check"),
)

_ROWS = tasks_table.c

# 列表页就这一个查询：最近改动的排前面（可以再按状态筛一档，那是行数很少之后的事，
# 走顺序过滤就够）。
Index("ix_tasks_updated", _ROWS.updated_at.desc())

# 一张单挂了哪些项目。挂在这一侧而不是 projects 那一侧：它是这张单的一个属性
# （「这摊活算在哪几个项目里」），而项目并不因为少了一张单就变成别的东西。
# 指向 projects 的外键写成字符串，所以这个模块不用 import 那个域。
task_projects_table = Table(
    "task_projects",
    metadata_obj,
    Column(
        "task_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.tasks.id", ondelete="cascade"),
        nullable=False,
    ),
    Column(
        "project_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.projects.id", ondelete="cascade"),
        nullable=False,
    ),
    # 两列即主键：同一张单挂同一个项目两遍，在表结构上就放不下。
    PrimaryKeyConstraint("task_id", "project_id"),
)

# 主键首列是 task_id，「这张单挂了哪些项目」够用了；反过来问「这个项目里有哪些单」
# 得自己一个索引。
Index("ix_task_projects_project", task_projects_table.c.project_id)


def _row(mapping: RowMapping) -> Task:
    return Task(
        id=mapping["id"],
        title=mapping["title"],
        status=mapping["status"],
        priority=mapping["priority"],
        deadline=mapping["deadline"],
        creator_user_id=mapping["creator_user_id"],
        style=style_from_payload(mapping["style"]),
        brief=brief_from_payload(mapping["brief"]),
        created_at=mapping["created_at"],
        updated_at=mapping["updated_at"],
    )


class SqlTaskRepository:
    """``TaskRepository`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def create(self, task: Task) -> Task:
        statement = (
            tasks_table.insert()
            .values(
                id=task.id,
                title=task.title,
                status=task.status,
                priority=task.priority,
                deadline=task.deadline,
                creator_user_id=task.creator_user_id,
                style=style_to_payload(task.style),
                brief=brief_to_payload(task.brief),
                created_at=func.now(),
                updated_at=func.now(),
            )
            .returning(*tasks_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one()
        return _row(row)

    async def get(self, task_id: uuid.UUID) -> Task:
        statement = select(tasks_table).where(_ROWS.id == task_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        if row is None:
            raise NotFound("没有这张需求单")
        return _row(row)

    async def list_recent(
        self, *, status: TaskStatus | None = None, limit: int
    ) -> tuple[Task, ...]:
        statement = select(tasks_table).order_by(_ROWS.updated_at.desc(), _ROWS.id.desc())
        if status is not None:
            statement = statement.where(_ROWS.status == status)
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement.limit(limit))).mappings().all()
        return tuple(_row(row) for row in rows)

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
        statement = (
            update(tasks_table)
            .where(_ROWS.id == task_id, _ROWS.status == expect)
            .values(
                title=title,
                priority=priority,
                deadline=deadline,
                brief=brief_to_payload(brief),
                updated_at=func.now(),
            )
            .returning(*tasks_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        return None if row is None else _row(row)

    async def publish(self, task_id: uuid.UUID) -> Task | None:
        # 期限的比较写在 WHERE 里，用的是数据库自己的 now()——见模块顶部。
        statement = (
            update(tasks_table)
            .where(
                _ROWS.id == task_id,
                _ROWS.status == STATUS_DRAFT,
                _ROWS.deadline.is_not(None),
                _ROWS.deadline > func.now(),
            )
            .values(status=STATUS_PUBLISHED, updated_at=func.now())
            .returning(*tasks_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        return None if row is None else _row(row)

    async def set_status(
        self, task_id: uuid.UUID, *, expect: TaskStatus, status: TaskStatus
    ) -> Task | None:
        statement = (
            update(tasks_table)
            .where(_ROWS.id == task_id, _ROWS.status == expect)
            .values(status=status, updated_at=func.now())
            .returning(*tasks_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        return None if row is None else _row(row)

    async def delete(self, task_id: uuid.UUID, *, expect: TaskStatus) -> bool:
        statement = (
            delete(tasks_table)
            .where(_ROWS.id == task_id, _ROWS.status == expect)
            .returning(_ROWS.id)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).first()
        return row is not None

    async def list_project_ids(self, task_id: uuid.UUID) -> tuple[uuid.UUID, ...]:
        statement = select(task_projects_table.c.project_id).where(
            task_projects_table.c.task_id == task_id
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).scalars().all()
        return tuple(rows)

    async def set_project_ids(
        self, task_id: uuid.UUID, *, project_ids: tuple[uuid.UUID, ...]
    ) -> tuple[uuid.UUID, ...]:
        # 一个事务里先清后插：整体覆盖的语义要求中间不存在「旧的删了、新的还没进去」
        # 被别人看到的时刻。
        try:
            async with self._engine.begin() as conn:
                await conn.execute(
                    delete(task_projects_table).where(task_projects_table.c.task_id == task_id)
                )
                if project_ids:
                    await conn.execute(
                        task_projects_table.insert(),
                        [
                            {"task_id": task_id, "project_id": project_id}
                            # 去重靠这里而不是靠主键报错：调用方给重了不该是个错误，
                            # 「挂两遍」和「挂一遍」本来就是同一件事。
                            for project_id in dict.fromkeys(project_ids)
                        ],
                    )
        except IntegrityError as exc:
            raise ValidationFailed("指定的项目里有不存在的") from exc
        return await self.list_project_ids(task_id)


__all__ = [
    "DB_SCHEMA",
    "SqlTaskRepository",
    "metadata_obj",
    "task_projects_table",
    "tasks_table",
]
