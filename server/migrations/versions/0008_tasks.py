"""iclip.tasks：创作需求单表

Revision ID: f1e6b83d2c47
Revises: d9c4a72e3b18
Create Date: 2026-08-24 23:30:00.000000

在这张表出现之前，「要做什么片子」只存在于聊天记录和口头交代里：谁提的、什么时候要、
下发了没有、被撤了没有，一个都答不上来，也没法排队。

三条约束写在数据库上，因为它们破了就是数据本身错了，不是某段代码错了：状态只有那
四个值；一旦下发就必须写着期限（草稿可以先空着）；brief 必须是个 JSON 对象。

``creator_user_id`` 用 restrict 而不是级联：一张下发过的需求单是公司账本上的事实，
不该跟着提它的那个账号一起消失。
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
    # 列表页就这一个查询：最近改动的排前面。
    op.create_index(
        "ix_tasks_updated",
        "tasks",
        [sa.text("updated_at DESC")],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_tasks_updated", table_name="tasks", schema=SCHEMA)
    op.drop_table("tasks", schema=SCHEMA)
