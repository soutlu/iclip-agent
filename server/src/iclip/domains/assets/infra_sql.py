"""素材的 Postgres 仓储。登记时间使用数据库时钟，读取不按属主隔离。"""

from __future__ import annotations

import uuid
from typing import Final

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    MetaData,
    Table,
    Text,
    Uuid,
    func,
    select,
)
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine.row import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import NotFound
from iclip.domains.assets.models import Asset, AssetType

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

media_assets_table = Table(
    "media_assets",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    # 删除账号不能级联删除素材记录。
    Column(
        "creator_user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="restrict"),
        nullable=False,
    ),
    # 不关联 api_keys 外键，保留 key 删除后的审计身份。
    Column("api_key_id", Uuid, nullable=True),
    Column("asset_type", Text, nullable=False),
    Column("object_key", Text, nullable=False, unique=True),
    Column("content_type", Text, nullable=False),
    Column("size_bytes", BigInteger, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    CheckConstraint("asset_type IN ('image', 'video')", name="media_assets_type_check"),
    CheckConstraint("size_bytes > 0", name="media_assets_size_check"),
)

_ROWS = media_assets_table.c

Index("ix_media_assets_created", _ROWS.created_at.desc())


def _row(mapping: RowMapping) -> Asset:
    return Asset(
        id=mapping["id"],
        creator_user_id=mapping["creator_user_id"],
        api_key_id=mapping["api_key_id"],
        asset_type=mapping["asset_type"],
        object_key=mapping["object_key"],
        content_type=mapping["content_type"],
        size_bytes=mapping["size_bytes"],
        created_at=mapping["created_at"],
    )


class SqlAssetRepository:
    """``AssetRepository`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def register(self, asset: Asset) -> Asset:
        statement = (
            pg_insert(media_assets_table)
            .values(
                id=asset.id,
                creator_user_id=asset.creator_user_id,
                api_key_id=asset.api_key_id,
                asset_type=asset.asset_type,
                object_key=asset.object_key,
                content_type=asset.content_type,
                size_bytes=asset.size_bytes,
                created_at=func.now(),
            )
            .on_conflict_do_nothing(index_elements=[_ROWS.id])
            .returning(*media_assets_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        # 重复登记返回既有记录，支持客户端重试。
        return await self.get(asset.id) if row is None else _row(row)

    async def get(self, asset_id: uuid.UUID) -> Asset:
        statement = select(media_assets_table).where(_ROWS.id == asset_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        if row is None:
            raise NotFound("没有这份素材")
        return _row(row)

    async def list_recent(
        self,
        *,
        creator_user_id: uuid.UUID | None = None,
        asset_type: AssetType | None = None,
        limit: int,
    ) -> tuple[Asset, ...]:
        statement = select(media_assets_table).order_by(_ROWS.created_at.desc(), _ROWS.id.desc())
        if creator_user_id is not None:
            statement = statement.where(_ROWS.creator_user_id == creator_user_id)
        if asset_type is not None:
            statement = statement.where(_ROWS.asset_type == asset_type)
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement.limit(limit))).mappings().all()
        return tuple(_row(row) for row in rows)


__all__ = [
    "DB_SCHEMA",
    "SqlAssetRepository",
    "media_assets_table",
    "metadata_obj",
]
