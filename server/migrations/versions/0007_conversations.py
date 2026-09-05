"""iclip.conversations：对话表

Revision ID: d9c4a72e3b18
Revises: c2a86e5b41f7
Create Date: 2026-08-24 21:00:00.000000

agent_id 来自配置声明，没有对应数据库记录，因此不建外键。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d9c4a72e3b18"
down_revision: str | None = "c2a86e5b41f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_user_id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        # 最近一次运行的标识，未运行时为空。
        sa.Column("last_run_id", sa.Text(), nullable=True),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("updated_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["owner_user_id"], [f"{SCHEMA}.users.id"], ondelete="cascade"),
        schema=SCHEMA,
    )
    # 复合索引覆盖属主查询，无需为 owner_user_id 单独建索引。
    op.create_index(
        "ix_conversations_owner_recent",
        "conversations",
        ["owner_user_id", sa.text("updated_at DESC")],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_owner_recent", table_name="conversations", schema=SCHEMA)
    op.drop_table("conversations", schema=SCHEMA)
