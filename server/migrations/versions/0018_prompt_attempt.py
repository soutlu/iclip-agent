"""agent_runtime.prompts：中断后被重新认领过几次

Revision ID: 4c8b1f7d3e60
Revises: 6e3f8a21c95b
Create Date: 2026-09-01 16:10:00.000000

清扫按这一列判「还要不要续跑」：到 ``max_attempts`` 就判失败，不再起新的 run。

老行按 0 回填，等于「还没被重新认领过」，它们仍有一次续跑的机会。
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
