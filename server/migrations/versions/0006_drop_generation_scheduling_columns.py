"""iclip.generation_jobs：移除调度列

Revision ID: c2a86e5b41f7
Revises: b7f3c1d90a24
Create Date: 2026-08-24 18:30:00.000000

调度状态统一由 procrastinate_jobs 管理；删除 attempts、next_attempt_at、lease_owner、
lease_expires_at 及对应的部分索引。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c2a86e5b41f7"
down_revision: str | None = "b7f3c1d90a24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.drop_index("ix_generation_jobs_due", "generation_jobs", schema=SCHEMA)
    for column in ("attempts", "next_attempt_at", "lease_owner", "lease_expires_at"):
        op.drop_column("generation_jobs", column, schema=SCHEMA)


def downgrade() -> None:
    """恢复调度列；NOT NULL 列使用默认值回填，原调度历史无法恢复。"""

    op.add_column(
        "generation_jobs",
        sa.Column("attempts", sa.BigInteger(), nullable=False, server_default="0"),
        schema=SCHEMA,
    )
    op.add_column(
        "generation_jobs",
        sa.Column(
            "next_attempt_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        schema=SCHEMA,
    )
    op.add_column(
        "generation_jobs",
        sa.Column("lease_owner", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "generation_jobs",
        sa.Column("lease_expires_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_generation_jobs_due",
        "generation_jobs",
        ["next_attempt_at"],
        schema=SCHEMA,
        postgresql_where=sa.text("status NOT IN ('completed', 'failed')"),
    )
