"""agent_runtime.prompts：审批等待与决定

Revision ID: 5f2a9c60d417
Revises: 4c8b1f7d3e60
Create Date: 2026-09-01 18:30:00.000000

decisions 保存 {toolCallId: 是否放行}，收齐本次响应的审批后续跑。
部分唯一索引包含 awaiting，防止审批等待期间同一会话启动另一条消息。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5f2a9c60d417"
down_revision: str | None = "4c8b1f7d3e60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"
INDEX = "uq_prompts_one_running_per_conversation"


def upgrade() -> None:
    op.add_column("prompts", sa.Column("decisions", sa.Text(), nullable=True), schema=SCHEMA)
    op.drop_index(INDEX, table_name="prompts", schema=SCHEMA)
    op.create_index(
        INDEX,
        "prompts",
        ["conversation_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('running', 'awaiting')"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(INDEX, table_name="prompts", schema=SCHEMA)
    op.create_index(
        INDEX,
        "prompts",
        ["conversation_id"],
        unique=True,
        postgresql_where=sa.text("status = 'running'"),
        schema=SCHEMA,
    )
    op.drop_column("prompts", "decisions", schema=SCHEMA)
