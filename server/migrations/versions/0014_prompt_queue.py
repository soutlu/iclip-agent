"""agent_runtime.prompts：消息队列与会话调度

Revision ID: 2f6c93a1d874
Revises: 7b1d4e6a92c3
Create Date: 2026-08-30 16:20:00.000000

部分唯一索引保证同一会话同时只有一条运行中的消息。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "2f6c93a1d874"
down_revision: str | None = "7b1d4e6a92c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.create_table(
        "prompts",
        sa.Column("prompt_id", sa.Text(), nullable=False),
        sa.Column("conversation_id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("owner_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("run_id", sa.Text(), nullable=True),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("finished_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("steered_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("prompt_id"),
        schema=SCHEMA,
    )
    op.create_index(
        "uq_prompts_one_running_per_conversation",
        "prompts",
        ["conversation_id"],
        unique=True,
        postgresql_where=sa.text("status = 'running'"),
        schema=SCHEMA,
    )
    op.create_index(
        "idx_prompts_queue",
        "prompts",
        ["conversation_id", "created_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("idx_prompts_queue", table_name="prompts", schema=SCHEMA)
    op.drop_index("uq_prompts_one_running_per_conversation", table_name="prompts", schema=SCHEMA)
    op.drop_table("prompts", schema=SCHEMA)
