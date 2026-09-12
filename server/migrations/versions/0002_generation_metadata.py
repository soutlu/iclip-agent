"""generation_jobs：`shot_index` 列与请求快照里的 `frameNumber` 并成调用方自带的 `metadata`。

Revision ID: 8b1f4a2c9d3e
Revises: c5d8a2f47e19
Create Date: 2026-09-12 12:00:00.000000

存量行只知道镜头组与帧号，不知道来自哪个分镜文件；仓库里分镜文件只有 `video_shot.json`
一个路径（web 的 SHOTS_PATH），回填按它写。决策见 docs/adr/0020-generation-metadata.md。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "8b1f4a2c9d3e"
down_revision: str | None = "c5d8a2f47e19"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("metadata", postgresql.JSONB(), nullable=True), schema=SCHEMA)
    # jsonb_strip_nulls 把视频行没有的 frame 去掉；两项都空的行 metadata 留 NULL。
    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE}
        SET metadata = jsonb_strip_nulls(
            jsonb_build_object(
                'path', 'video_shot.json',
                'shot', shot_index,
                'frame', (request ->> 'frameNumber')::int
            )
        )
        WHERE shot_index IS NOT NULL OR request ? 'frameNumber'
        """
    )
    op.execute(
        f"UPDATE {SCHEMA}.{TABLE} SET request = request - 'frameNumber' WHERE request ? 'frameNumber'"
    )
    op.drop_column(TABLE, "shot_index", schema=SCHEMA)


def downgrade() -> None:
    """只搬回分镜页那种形状的坐标；别的调用方写的 shot / frame 不是数字就不动，免得 ::int 中断降级。"""

    op.add_column(TABLE, sa.Column("shot_index", sa.Integer(), nullable=True), schema=SCHEMA)
    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE}
        SET shot_index = (metadata ->> 'shot')::int
        WHERE jsonb_typeof(metadata -> 'shot') = 'number'
        """
    )
    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE}
        SET request = request || jsonb_build_object('frameNumber', (metadata ->> 'frame')::int)
        WHERE kind = 'image' AND jsonb_typeof(metadata -> 'frame') = 'number'
        """
    )
    op.drop_column(TABLE, "metadata", schema=SCHEMA)
