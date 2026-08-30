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
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine.row import RowMapping
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.common.errors import NotFound
from iclip.domains.tasks.models import (
    STATUS_CONFIRMED,
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

# 谁认领了哪张单：两列外键加联合主键，「认领两遍」在表结构上就放不下。撤回不清这里
# 的行——撤回是单的终态，认领记录是各自发生过的事实。
task_assignees_table = Table(
    "task_assignees",
    metadata_obj,
    Column(
        "task_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.tasks.id", ondelete="cascade"),
        nullable=False,
    ),
    # restrict 同 creator_user_id：认领记录不该跟着账号一起消失。
    Column(
        "user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="restrict"),
        nullable=False,
    ),
    Column("created_at", DateTime(timezone=True), nullable=False),
    PrimaryKeyConstraint("task_id", "user_id"),
)

# 主键首列是 task_id，「这张单谁认领了」够用了；反过来问「这个人认领了哪些单」
# （「我的项目」那一栏）得自己一个索引。
Index("ix_task_assignees_user", task_assignees_table.c.user_id)


def _row(mapping: RowMapping, assignee_user_ids: tuple[uuid.UUID, ...] = ()) -> Task:
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
        assignee_user_ids=assignee_user_ids,
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
            assignees = await self._assignees_of(conn, [task_id])
        return _row(row, assignees.get(task_id, ()))

    async def list_recent(
        self,
        *,
        status: TaskStatus | None = None,
        assignee_user_id: uuid.UUID | None = None,
        limit: int,
    ) -> tuple[Task, ...]:
        statement = select(tasks_table).order_by(_ROWS.updated_at.desc(), _ROWS.id.desc())
        if status is not None:
            statement = statement.where(_ROWS.status == status)
        if assignee_user_id is not None:
            statement = statement.where(
                _ROWS.id.in_(
                    select(task_assignees_table.c.task_id).where(
                        task_assignees_table.c.user_id == assignee_user_id
                    )
                )
            )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement.limit(limit))).mappings().all()
            assignees = await self._assignees_of(conn, [row["id"] for row in rows])
        return tuple(_row(row, assignees.get(row["id"], ())) for row in rows)

    @staticmethod
    async def _assignees_of(
        conn: AsyncConnection, task_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, tuple[uuid.UUID, ...]]:
        """批量取这几张单的认领人。一次查询拿回来再按单分组，避免逐单点射。"""

        if not task_ids:
            return {}
        statement = (
            select(task_assignees_table.c.task_id, task_assignees_table.c.user_id)
            .where(task_assignees_table.c.task_id.in_(task_ids))
            .order_by(task_assignees_table.c.created_at)
        )
        rows = (await conn.execute(statement)).all()
        grouped: dict[uuid.UUID, list[uuid.UUID]] = {}
        for row in rows:
            grouped.setdefault(row.task_id, []).append(row.user_id)
        return {task_id: tuple(ids) for task_id, ids in grouped.items()}

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
            if row is None:
                return None
            assignees = await self._assignees_of(conn, [task_id])
        return _row(row, assignees.get(task_id, ()))

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
            if row is None:
                return None
            assignees = await self._assignees_of(conn, [task_id])
        return _row(row, assignees.get(task_id, ()))

    async def confirm(self, task_id: uuid.UUID, *, user_id: uuid.UUID) -> Task | None:
        async with self._engine.begin() as conn:
            current = (
                await conn.execute(
                    select(_ROWS.status).where(_ROWS.id == task_id).with_for_update()
                )
            ).scalar_one_or_none()
            if current not in (STATUS_PUBLISHED, STATUS_CONFIRMED):
                return None
            await conn.execute(
                pg_insert(task_assignees_table)
                .values(task_id=task_id, user_id=user_id, created_at=func.now())
                .on_conflict_do_nothing()
            )
            row = (
                (
                    await conn.execute(
                        update(tasks_table)
                        .where(_ROWS.id == task_id, _ROWS.status == STATUS_PUBLISHED)
                        .values(status=STATUS_CONFIRMED, updated_at=func.now())
                        .returning(*tasks_table.c)
                    )
                )
                .mappings()
                .one_or_none()
            )
            if row is None:
                # 已经在 confirmed：追加认领人即可，行本身没变，重新读一次。
                row = (
                    (await conn.execute(select(tasks_table).where(_ROWS.id == task_id)))
                    .mappings()
                    .one()
                )
            assignees = await self._assignees_of(conn, [task_id])
        return _row(row, assignees.get(task_id, ()))

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
            if row is None:
                return None
            assignees = await self._assignees_of(conn, [task_id])
        return _row(row, assignees.get(task_id, ()))

    async def delete(self, task_id: uuid.UUID, *, expect: TaskStatus) -> bool:
        statement = (
            delete(tasks_table)
            .where(_ROWS.id == task_id, _ROWS.status == expect)
            .returning(_ROWS.id)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).first()
        return row is not None


__all__ = [
    "DB_SCHEMA",
    "SqlTaskRepository",
    "metadata_obj",
    "task_assignees_table",
    "tasks_table",
]
