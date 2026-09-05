"""agent_runtime.prompts：运行租约

Revision ID: 9d4b7c1f6a28
Revises: 4c8e1b70d925
Create Date: 2026-09-01 09:40:00.000000

locked_by 标识执行进程，heartbeat_at 记录心跳，interrupt_reason 记录中断原因。
存量 running 行回填迁移时刻，确保租约到期后可被清扫；NULL 心跳无法命中超时比较条件。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "9d4b7c1f6a28"
down_revision: str | None = "4c8e1b70d925"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.add_column("prompts", sa.Column("locked_by", sa.Text(), nullable=True), schema=SCHEMA)
    op.add_column(
        "prompts",
        sa.Column("heartbeat_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.add_column("prompts", sa.Column("interrupt_reason", sa.Text(), nullable=True), schema=SCHEMA)
    op.execute(
        sa.text(f"UPDATE {SCHEMA}.prompts SET heartbeat_at = now() WHERE status = 'running'")
    )
    op.create_index(
        "idx_prompts_lease",
        "prompts",
        ["heartbeat_at"],
        postgresql_where=sa.text("status = 'running'"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("idx_prompts_lease", table_name="prompts", schema=SCHEMA)
    op.drop_column("prompts", "interrupt_reason", schema=SCHEMA)
    op.drop_column("prompts", "heartbeat_at", schema=SCHEMA)
    op.drop_column("prompts", "locked_by", schema=SCHEMA)
