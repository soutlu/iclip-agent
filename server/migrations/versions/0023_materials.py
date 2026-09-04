"""agent_runtime.materials：一段对话能用哪些素材

Revision ID: 5e2a9c47b013
Revises: 9b41c7d0e28f
Create Date: 2026-09-04 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "5e2a9c47b013"
down_revision: str | None = "9b41c7d0e28f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.create_table(
        "materials",
        sa.Column("namespace", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        # 主键首列就是 namespace，查一条与清一整段对话都走它，不再另建索引。
        sa.PrimaryKeyConstraint("namespace", "url"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("materials", schema=SCHEMA)
