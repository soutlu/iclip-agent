"""``MaterialLedger`` 的 Postgres 后端。表在 ``agent_runtime`` schema，DDL 由 Alembic 拥有。"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final, cast

from sqlalchemy import (
    Column,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    delete,
    func,
    select,
)
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.platform.material_ledger.store import Material, MaterialKind

DB_SCHEMA: Final = "agent_runtime"

metadata_obj = MetaData(schema=DB_SCHEMA)

materials_table = Table(
    "materials",
    metadata_obj,
    Column("namespace", Text, nullable=False),
    Column("url", Text, nullable=False),
    Column("kind", Text, nullable=False),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=func.now()),
    PrimaryKeyConstraint("namespace", "url"),
)


class PgMaterialLedger:
    """``MaterialLedger`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def record(self, namespace: str, materials: Sequence[Material]) -> None:
        """幂等登记素材；空输入不执行 INSERT，避免缺少 VALUES 的无效语句。"""

        if not materials:
            return
        table = materials_table
        statement = pg_insert(table).values(
            [
                {"namespace": namespace, "url": material.url, "kind": material.kind}
                for material in materials
            ]
        )
        async with self._engine.begin() as conn:
            await conn.execute(
                statement.on_conflict_do_nothing(index_elements=[table.c.namespace, table.c.url])
            )

    async def lookup(self, namespace: str, url: str) -> Material | None:
        """按完整 URL 精确查询，不进行归一化。"""

        table = materials_table
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(table.c.kind).where(table.c.namespace == namespace, table.c.url == url)
                )
            ).first()
        if row is None:
            return None
        return Material(url=url, kind=cast(MaterialKind, row[0]))

    async def purge_namespace(self, namespace: str) -> None:
        """由宿主在删除会话时清理命名空间素材。"""

        table = materials_table
        async with self._engine.begin() as conn:
            await conn.execute(delete(table).where(table.c.namespace == namespace))


__all__ = ["DB_SCHEMA", "PgMaterialLedger", "materials_table", "metadata_obj"]
