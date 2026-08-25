"""``iclip.media_assets`` 的 Postgres 后端。DDL 归 Alembic，这里不建表。

**登记时刻取数据库的时钟**（``now()``）：多台应用服务器的钟差几秒，列表的先后就会
和实际登记顺序对不上。

**没有属主过滤**：素材是全公司共用的（见 ``repository.py``），所以这里不用
``platform/db`` 的行级归属原语——那是给私人资源用的。
"""

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
    # 不级联删除：素材是公司账本上的事实，不该跟着传它的那个账号一起消失（同
    # tasks.creator_user_id）。账号目前只停用不删除，所以 restrict 不会挡住任何
    # 正常路径；真去删就该响亮地失败。
    Column(
        "creator_user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="restrict"),
        nullable=False,
    ),
    # 故意没有到 api_keys 的外键：key 随属主级联删除，而「哪把 key 干的」这条审计
    # 事实必须比那把 key 活得更久（同 generation_jobs）。
    Column("api_key_id", Uuid, nullable=True),
    Column("asset_type", Text, nullable=False),
    # 唯一：一个对象只该在账本上出现一次。key 由 assetId 派生，所以这条唯一约束
    # 实际守的是「同一份素材被登记两遍」。
    Column("object_key", Text, nullable=False, unique=True),
    Column("content_type", Text, nullable=False),
    Column("size_bytes", BigInteger, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    CheckConstraint("asset_type IN ('image', 'video')", name="media_assets_type_check"),
    CheckConstraint("size_bytes > 0", name="media_assets_size_check"),
)

_ROWS = media_assets_table.c

# 列表页就这一个查询：最近登记的排前面。按创建者或类型筛是在它之上的顺序过滤，
# 行数很少之后再说。
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
        # 冲突即「这一行早就登记过了」——重试打到这里是正常路径，把既有那行读回来。
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
