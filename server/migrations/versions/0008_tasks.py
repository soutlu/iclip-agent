"""iclip.tasks：创作需求单表

Revision ID: f1e6b83d2c47
Revises: d9c4a72e3b18
Create Date: 2026-08-24 23:30:00.000000

数据库约束状态取值、下发期限和 brief 的 JSON 对象类型。
creator_user_id 使用 RESTRICT，保留需求单记录，避免随创建者账号级联删除。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f1e6b83d2c47"
down_revision: str | None = "d9c4a72e3b18"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.create_table(
        "tasks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("deadline", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("creator_user_id", sa.Uuid(), nullable=False),
        sa.Column("brief", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("updated_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["creator_user_id"], [f"{SCHEMA}.users.id"], ondelete="restrict"),
        sa.CheckConstraint(
            "status IN ('draft', 'published', 'confirmed', 'withdrawn')",
            name="tasks_status_check",
        ),
        sa.CheckConstraint("status = 'draft' OR deadline IS NOT NULL", name="tasks_deadline_check"),
        sa.CheckConstraint("jsonb_typeof(brief) = 'object'", name="tasks_brief_object_check"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_tasks_updated",
        "tasks",
        [sa.text("updated_at DESC")],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_tasks_updated", table_name="tasks", schema=SCHEMA)
    op.drop_table("tasks", schema=SCHEMA)
