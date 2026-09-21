"""generation_jobs：把坐标里的 ``path`` 清掉，只留 ``shot`` / ``frame``。

Revision ID: 5a9c2e17bd48
Revises: 8d1c5f26ba34
Create Date: 2026-09-20 10:00:00.000000

``path`` 是分镜页当初自己加的一行常量（仓库里只有一份 ``video_shot.json``），却被前端当成必填，
于是只发 ``shot_index`` 的调用方出的片在分镜页一条都显示不出来。前端改成只认 ``shot`` 之后，
这一行在库里也不留：0002 给每条回填行都写了它，此后分镜页写的每条也带着它。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "5a9c2e17bd48"
down_revision: str | None = "8d1c5f26ba34"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"


def upgrade() -> None:
    """``NULLIF`` 只管本次动过的行：清完只剩空对象的，本来就没有坐标。"""

    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE}
        SET metadata = NULLIF(metadata - 'path', '{{}}'::jsonb)
        WHERE jsonb_exists(metadata, 'path')
        """
    )


def downgrade() -> None:
    """清掉的是一行冗余常量，降级不把它造回来。"""
