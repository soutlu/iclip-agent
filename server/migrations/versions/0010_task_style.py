"""iclip.tasks：加一列款号快照

Revision ID: a4d7c9518e63
Revises: b6a3f109d84e
Create Date: 2026-08-25 14:00:00.000000

需求单原来记不下「要拍哪个款」，而款号正是这张单子的由来。

这一列存下单那天的样子（款号、品牌名、品类名、封面地址），不是外键：上游随时改名换
图，历史需求单不该跟着变样。

NOT NULL 且不给默认值：表里有存量行时加列会失败，那时该有人来看一眼，而不是悄悄塞
个空对象进去。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a4d7c9518e63"
down_revision: str | None = "b6a3f109d84e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column("style", postgresql.JSONB(), nullable=False),
        schema=SCHEMA,
    )
    # 和 brief 那条同一个道理：它得是个 JSON 对象，不能是数组或裸值。
    op.create_check_constraint(
        "tasks_style_object_check",
        "tasks",
        "jsonb_typeof(style) = 'object'",
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_constraint("tasks_style_object_check", "tasks", schema=SCHEMA, type_="check")
    op.drop_column("tasks", "style", schema=SCHEMA)
