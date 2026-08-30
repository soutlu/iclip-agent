"""``iclip.collections`` 的 Postgres 后端。DDL 归 Alembic，这里不建表。

所有时刻都取数据库的时钟（``now()``）：合集列表按「最近改动」排，多台应用服务器的
时钟差几秒这个排序就乱了。
"""

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
    # restrict 而不是 cascade：合集是记录在案的东西，不该跟着建它的那个账号一起消失
    # （同 tasks.creator_user_id）。
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

# 侧栏那个查询：我的合集，最近改动的排前面。
Index("ix_collections_owner_recent", _ROWS.owner_user_id, _ROWS.updated_at.desc())
# 治理者的全量视图：跨属主按最近改动排。
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
    """属主条件。``None`` 是治理者的全量视图，不加这一条。"""

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
