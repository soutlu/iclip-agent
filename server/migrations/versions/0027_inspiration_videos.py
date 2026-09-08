"""iclip.inspiration_videos：自家款在平台上的爆款视频快照

数据是 2026-09-08 从外部数仓（爆款榜 + 视频打标库）与 BDE（款号、品类、品牌）
离线解析后的一次性快照，随迁移导入，运行时不连任何外部库。刷新数据的办法是
替换同目录的 CSV 并追加一个新迁移；本表不做增量。

只收有 OSS 副本、且款号能解析到 PDM 的行：源表 2458 行 → 2197 行有副本
→ 2160 行 style 非空 → 2149 行款号可解析。丢弃的 11 行来自 7 个 ERP 直建款
（JFFW-*、SDFW-*），PDM 中没有对应的款，留下也永远匹配不到。

Revision ID: c3f7a1e94b28
Revises: 2b81a3dfe6c4
Create Date: 2026-09-08 02:20:00.000000
"""

from __future__ import annotations

import csv
import datetime as dt
from collections.abc import Sequence
from decimal import Decimal
from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision: str = "c3f7a1e94b28"
down_revision: str | None = "2b81a3dfe6c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "inspiration_videos"
SEED = Path(__file__).resolve().parent.parent / "data" / "inspiration_videos.csv"


def upgrade() -> None:
    table = op.create_table(
        TABLE,
        sa.Column("video_id", sa.Text(), nullable=False),
        # 数仓原样给的编号，永不改写：出问题时它是唯一能对回源头的线索。
        sa.Column("style_raw", sa.Text(), nullable=False),
        sa.Column("style_no", sa.Text(), nullable=False),
        sa.Column("category_id", sa.Integer(), nullable=False),
        sa.Column("category_name", sa.Text(), nullable=False),
        sa.Column("brand_code", sa.Text(), nullable=False),
        sa.Column("brand_name", sa.Text(), nullable=False),
        sa.Column("oss_url", sa.Text(), nullable=False),
        sa.Column("posted_date", sa.Date(), nullable=True),
        sa.Column("impressions", sa.BigInteger(), nullable=False),
        sa.Column("views", sa.BigInteger(), nullable=False),
        sa.Column("clicks", sa.BigInteger(), nullable=False),
        sa.Column("orders", sa.BigInteger(), nullable=False),
        # 金额走 Numeric，不用浮点。
        sa.Column("revenue", sa.Numeric(), nullable=False),
        sa.PrimaryKeyConstraint("video_id"),
        schema=SCHEMA,
    )
    # 精确匹配走 style_no；回退按 (品类, 品牌) 与品类两级收窄。
    op.create_index("ix_inspiration_videos_style_no", TABLE, ["style_no"], schema=SCHEMA)
    op.create_index(
        "ix_inspiration_videos_category_brand",
        TABLE,
        ["category_id", "brand_code"],
        schema=SCHEMA,
    )
    op.bulk_insert(table, _seed_rows())


def downgrade() -> None:
    op.drop_index("ix_inspiration_videos_category_brand", TABLE, schema=SCHEMA)
    op.drop_index("ix_inspiration_videos_style_no", TABLE, schema=SCHEMA)
    op.drop_table(TABLE, schema=SCHEMA)


def _seed_rows() -> list[dict[str, object]]:
    """读取随仓库分发的快照；缺文件即失败，不静默建空表。"""

    with SEED.open(encoding="utf-8", newline="") as handle:
        return [
            {
                "video_id": row["video_id"],
                "style_raw": row["style_raw"],
                "style_no": row["style_no"],
                "category_id": int(row["category_id"]),
                "category_name": row["category_name"],
                "brand_code": row["brand_code"],
                "brand_name": row["brand_name"],
                "oss_url": row["oss_url"],
                "posted_date": (
                    dt.date.fromisoformat(row["posted_date"]) if row["posted_date"] else None
                ),
                "impressions": int(row["impressions"]),
                "views": int(row["views"]),
                "clicks": int(row["clicks"]),
                "orders": int(row["orders"]),
                "revenue": Decimal(row["revenue"]),
            }
            for row in csv.DictReader(handle)
        ]
