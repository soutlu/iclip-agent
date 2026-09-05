"""iclip.generation_jobs：媒体生成任务表

Revision ID: e5b92c4718af
Revises: a4d7b1c2e903
Create Date: 2026-08-24 15:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e5b92c4718af"
down_revision: str | None = "a4d7b1c2e903"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.create_table(
        "generation_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_user_id", sa.Uuid(), nullable=False),
        # 不建 api_keys 外键，保留密钥删除后的审计标识。
        sa.Column("api_key_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("request", postgresql.JSONB(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("provider_task_id", sa.Text(), nullable=True),
        sa.Column("provider_status", sa.Text(), nullable=True),
        sa.Column("provider_snapshot", postgresql.JSONB(), nullable=True),
        sa.Column("output_url", sa.Text(), nullable=True),
        sa.Column("attempts", sa.BigInteger(), nullable=False),
        sa.Column("next_attempt_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("lease_owner", sa.Text(), nullable=True),
        sa.Column("lease_expires_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("updated_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("submitted_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("finished_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["owner_user_id"], [f"{SCHEMA}.users.id"], ondelete="cascade"),
        schema=SCHEMA,
    )
    # 部分索引仅包含非终态任务，避免历史任务增加领取查询开销。
    op.create_index(
        "ix_generation_jobs_due",
        "generation_jobs",
        ["next_attempt_at"],
        schema=SCHEMA,
        postgresql_where=sa.text("status NOT IN ('completed', 'failed')"),
    )
    op.create_index(
        "ix_generation_jobs_owner_created",
        "generation_jobs",
        ["owner_user_id", "created_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_generation_jobs_owner_created", "generation_jobs", schema=SCHEMA)
    op.drop_index("ix_generation_jobs_due", "generation_jobs", schema=SCHEMA)
    op.drop_table("generation_jobs", schema=SCHEMA)
