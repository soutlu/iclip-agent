"""合集的 Postgres 仓储。时间统一取数据库 now()，避免应用实例钟差影响排序。"""

from __future__ import annotations

import uuid
from typing import Final

from sqlalchemy import (
    Column,
    ColumnElement,
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
from iclip.domains.collections.models import Collection

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

collections_table = Table(
    "collections",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    # 删除账号不能级联删除合集。
    Column(
        "owner_user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="restrict"),
        nullable=False,
    ),
    Column("name", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

_ROWS = collections_table.c

Index("ix_collections_owner_recent", _ROWS.owner_user_id, _ROWS.updated_at.desc())
Index("ix_collections_updated", _ROWS.updated_at.desc())


def _row(mapping: RowMapping) -> Collection:
    return Collection(
        id=mapping["id"],
        owner_user_id=mapping["owner_user_id"],
        name=mapping["name"],
        created_at=mapping["created_at"],
        updated_at=mapping["updated_at"],
    )


def _scope(owner: uuid.UUID | None) -> list[ColumnElement[bool]]:
    """None 表示治理者的全量视图，不添加属主条件。"""

    return [] if owner is None else [_ROWS.owner_user_id == owner]


class SqlCollectionRepository:
    """``CollectionRepository`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def create(self, collection: Collection) -> Collection:
        statement = (
            collections_table.insert()
            .values(
                id=collection.id,
                owner_user_id=collection.owner_user_id,
                name=collection.name,
                created_at=func.now(),
                updated_at=func.now(),
            )
            .returning(*collections_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one()
        return _row(row)

    async def get(self, collection_id: uuid.UUID, *, owner: uuid.UUID | None) -> Collection:
        statement = select(collections_table).where(_ROWS.id == collection_id, *_scope(owner))
        async with self._engine.connect() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        if row is None:
            raise NotFound("没有这个合集")
        return _row(row)

    async def list_recent(
        self, *, owner: uuid.UUID | None, limit: int, offset: int = 0
    ) -> tuple[Collection, ...]:
        statement = (
            select(collections_table)
            .where(*_scope(owner))
            .order_by(_ROWS.updated_at.desc(), _ROWS.id)
            .limit(limit)
            .offset(offset)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()
        return tuple(_row(row) for row in rows)

    async def rename(
        self, collection_id: uuid.UUID, *, owner: uuid.UUID | None, name: str
    ) -> Collection:
        statement = (
            update(collections_table)
            .where(_ROWS.id == collection_id, *_scope(owner))
            .values(name=name, updated_at=func.now())
            .returning(*collections_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        if row is None:
            raise NotFound("没有这个合集")
        return _row(row)

    async def delete(self, collection_id: uuid.UUID, *, owner: uuid.UUID | None) -> None:
        statement = (
            delete(collections_table)
            .where(_ROWS.id == collection_id, *_scope(owner))
            .returning(_ROWS.id)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).first()
        if row is None:
            raise NotFound("没有这个合集")


__all__ = [
    "DB_SCHEMA",
    "SqlCollectionRepository",
    "collections_table",
    "metadata_obj",
]
