"""iclip.media_assets：素材账本

Revision ID: b6a3f109d84e
Revises: f1e6b83d2c47
Create Date: 2026-08-25 10:00:00.000000

存储 object key，访问 URL 由配置生成，避免 CDN 域名变更要求迁移数据。
素材须先转存到自有对象存储，不直接登记可能过期的外部 URL。
creator_user_id 使用 RESTRICT 保留素材记录；api_key_id 不建外键，以保留密钥删除后的审计信息。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b6a3f109d84e"
down_revision: str | None = "f1e6b83d2c47"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.create_table(
        "media_assets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("creator_user_id", sa.Uuid(), nullable=False),
        sa.Column("api_key_id", sa.Uuid(), nullable=True),
        sa.Column("asset_type", sa.Text(), nullable=False),
        sa.Column("object_key", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["creator_user_id"], [f"{SCHEMA}.users.id"], ondelete="restrict"),
        # object key 由 assetId 派生，唯一约束防止同一素材重复登记。
        sa.UniqueConstraint("object_key", name="media_assets_object_key_key"),
        sa.CheckConstraint("asset_type IN ('image', 'video')", name="media_assets_type_check"),
        sa.CheckConstraint("size_bytes > 0", name="media_assets_size_check"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_media_assets_created",
        "media_assets",
        [sa.text("created_at DESC")],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_media_assets_created", table_name="media_assets", schema=SCHEMA)
    op.drop_table("media_assets", schema=SCHEMA)
