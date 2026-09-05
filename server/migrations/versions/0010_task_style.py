"""iclip.tasks：款号快照

Revision ID: a4d7c9518e63
Revises: b6a3f109d84e
Create Date: 2026-08-25 14:00:00.000000

保存下单时的款号、品牌、品类与封面，避免上游资料变更影响历史需求单。
新增列为 NOT NULL 且无默认值；存在存量行时迁移会失败，需要先明确回填数据。
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
    op.create_check_constraint(
        "tasks_style_object_check",
        "tasks",
        "jsonb_typeof(style) = 'object'",
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_constraint("tasks_style_object_check", "tasks", schema=SCHEMA, type_="check")
    op.drop_column("tasks", "style", schema=SCHEMA)
