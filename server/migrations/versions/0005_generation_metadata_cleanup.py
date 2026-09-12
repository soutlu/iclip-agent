"""generation_jobs：把 0002 误回填成只有 ``path`` 的坐标清成 NULL。

Revision ID: 2d6f8a1b4c07
Revises: 9e3a7c5b2d41
Create Date: 2026-09-12 16:00:00.000000

0002 用 ``request ? 'frameNumber'`` 挑要回填的行，而图片请求快照里这个键存在但值为 null 的行
（agent 工具出的图）也被挑中，``jsonb_strip_nulls`` 之后只剩 ``{"path": "video_shot.json"}``。
这些行本来没有坐标，正确的值是 NULL。分镜页只写带 ``shot`` 的形状，按整值相等清理不会误伤。
已上线的库不改 0002，用这一步补；新库连跑两步结果相同。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "2d6f8a1b4c07"
down_revision: str | None = "9e3a7c5b2d41"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE}
        SET metadata = NULL
        WHERE metadata = '{{"path": "video_shot.json"}}'::jsonb
        """
    )


def downgrade() -> None:
    """清掉的值本来就不该存在，降级不把它们造回来；0002 的 downgrade 不依赖这一项。"""
