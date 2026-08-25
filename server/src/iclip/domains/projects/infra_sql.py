"""``iclip.projects`` 的 Postgres 后端。DDL 归 Alembic，这里不建表。

所有时刻都取数据库的时钟（``now()``）：项目列表按「最近改动」排，多台应用服务器的
时钟差几秒这个排序就乱了。
"""

from __future__ import annotations

import uuid
from typing import Final

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    MetaData,
    Table,
    Text,
    Uuid,
    delete,
    func,
    select,
    update,
)
from sqlalchemy.engine.row import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import NotFound
from iclip.domains.projects.models import Project

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

projects_table = Table(
    "projects",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    # restrict 而不是 cascade：项目是记录在案的东西，不该跟着建它的那个账号一起消失
    # （同 tasks.creator_user_id）。
    Column(
        "creator_user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="restrict"),
        nullable=False,
    ),
    Column("name", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

_ROWS = projects_table.c

# 列表页就这一个查询：全公司的项目，最近改动的排前面。
Index("ix_projects_updated", _ROWS.updated_at.desc())


def _row(mapping: RowMapping) -> Project:
    return Project(
        id=mapping["id"],
        creator_user_id=mapping["creator_user_id"],
        name=mapping["name"],
        created_at=mapping["created_at"],
        updated_at=mapping["updated_at"],
    )


class SqlProjectRepository:
    """``ProjectRepository`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def create(self, project: Project) -> Project:
        statement = (
            projects_table.insert()
            .values(
                id=project.id,
                creator_user_id=project.creator_user_id,
                name=project.name,
                created_at=func.now(),
                updated_at=func.now(),
            )
            .returning(*projects_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one()
        return _row(row)

    async def get(self, project_id: uuid.UUID) -> Project:
        statement = select(projects_table).where(_ROWS.id == project_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        if row is None:
            raise NotFound("没有这个项目")
        return _row(row)

    async def list_recent(self, *, limit: int) -> tuple[Project, ...]:
        statement = select(projects_table).order_by(_ROWS.updated_at.desc()).limit(limit)
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()
        return tuple(_row(row) for row in rows)

    async def rename(self, project_id: uuid.UUID, *, name: str) -> Project:
        statement = (
            update(projects_table)
            .where(_ROWS.id == project_id)
            .values(name=name, updated_at=func.now())
            .returning(*projects_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        if row is None:
            raise NotFound("没有这个项目")
        return _row(row)

    async def delete(self, project_id: uuid.UUID) -> None:
        statement = delete(projects_table).where(_ROWS.id == project_id).returning(_ROWS.id)
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).first()
        if row is None:
            raise NotFound("没有这个项目")


__all__ = [
    "DB_SCHEMA",
    "SqlProjectRepository",
    "metadata_obj",
    "projects_table",
]
