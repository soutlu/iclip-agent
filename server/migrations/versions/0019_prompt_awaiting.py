"""agent_runtime.prompts：等审批的那条行与它记下的决定

Revision ID: 5f2a9c60d417
Revises: 4c8b1f7d3e60
Create Date: 2026-09-01 18:30:00.000000

``decisions`` 是 ``{toolCallId: 是否放行}`` 的 JSON，凑齐一次响应里的全部审批才起续跑。

「一段对话同时只跑一条」那道部分唯一索引要把 ``awaiting`` 一并算进去：等审批的那一轮并没有
结束，条件只写 ``running`` 的话，等审批期间新来的 prompt 会被判成在跑，同一段对话跑两条。
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
