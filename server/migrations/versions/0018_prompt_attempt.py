"""agent_runtime.prompts：认领次数

Revision ID: 4c8b1f7d3e60
Revises: 6e3f8a21c95b
Create Date: 2026-09-01 16:10:00.000000

清扫根据 attempt 与 max_attempts 判断是否续跑；存量行回填为 0。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4c8b1f7d3e60"
down_revision: str | None = "6e3f8a21c95b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.add_column(
        "prompts",
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="0"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("prompts", "attempt", schema=SCHEMA)
