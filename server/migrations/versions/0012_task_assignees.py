"""iclip.task_assignees：需求单认领记录

Revision ID: 5f2a9c41d8b0
Revises: c8e2b47f1a95
Create Date: 2026-08-29 10:00:00.000000

联合主键防止重复认领，需求单撤回后保留记录。
用户外键使用 RESTRICT，避免删除账号时级联删除认领记录。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5f2a9c41d8b0"
down_revision: str | None = "c8e2b47f1a95"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.create_table(
        "task_assignees",
        sa.Column(
            "task_id",
            sa.Uuid(),
            sa.ForeignKey(f"{SCHEMA}.tasks.id", ondelete="cascade"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey(f"{SCHEMA}.users.id", ondelete="restrict"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("task_id", "user_id"),
        schema=SCHEMA,
    )
    # 联合主键仅覆盖 task_id 查询，认领人维度需单独索引。
    op.create_index(
        "ix_task_assignees_user",
        "task_assignees",
        ["user_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_task_assignees_user", "task_assignees", schema=SCHEMA)
    op.drop_table("task_assignees", schema=SCHEMA)
