"""iclip.media_assets：素材账本

Revision ID: b6a3f109d84e
Revises: f1e6b83d2c47
Create Date: 2026-08-25 10:00:00.000000

在这张表出现之前，系统里没有任何地方回答得了「我们手上有哪些素材」：生成结果只存在
于各自那一行任务上，用户想传一份参考片进来更是无处可放（连上传口都没有）。

**行上存的是 object key，不是 URL。** 桶是知道的，公网前缀是配置——把地址存进库里，
换一次 CDN 域名就得迁一次数据。反过来，key 是身份，地址是它的投影。

**没有放外部地址的列。** 这是有意的：要进账本，字节就得先转存进我们自己的桶
（provider 给的视频地址会过期，外部图库的图不归我们）。

``creator_user_id`` 用 restrict 而不是级联：素材是公司账本上的事实，不该跟着传它的
那个账号一起消失（同 tasks）。到 api_keys 则故意没有外键：key 随属主级联删除，而
「哪把 key 干的」这条审计事实必须比那把 key 活得更久（同 generation_jobs）。
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
        # 一个对象只该在账本上出现一次。key 由 assetId 派生，所以这条守的是「同一份
        # 素材被登记两遍」。
        sa.UniqueConstraint("object_key", name="media_assets_object_key_key"),
        sa.CheckConstraint("asset_type IN ('image', 'video')", name="media_assets_type_check"),
        sa.CheckConstraint("size_bytes > 0", name="media_assets_size_check"),
        schema=SCHEMA,
    )
    # 列表页就这一个查询：最近登记的排前面。
    op.create_index(
        "ix_media_assets_created",
        "media_assets",
        [sa.text("created_at DESC")],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_media_assets_created", table_name="media_assets", schema=SCHEMA)
    op.drop_table("media_assets", schema=SCHEMA)
