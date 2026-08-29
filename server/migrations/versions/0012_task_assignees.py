"""iclip.task_assignees：谁认领了哪张需求单

Revision ID: 5f2a9c41d8b0
Revises: c8e2b47f1a95
Create Date: 2026-08-29 10:00:00.000000

认领是记录在案的事实：一张需求单可以被多个人认领（同一个人只记一行），撤回之后这些
行也留着——它们和单本身一样是发生过的事。结构照 ``task_projects`` 的样子来：两列
外键加联合主键，「认领两遍」在表结构上就放不下。

指向 users 的外键用 RESTRICT 而不是 CASCADE（同 tasks.creator_user_id 的注释）：账号
只停用不删除，认领记录不该跟着账号一起消失。
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
    # 主键首列是 task_id，「这张单谁认领了」够用了；反过来问「这个人认领了哪些单」
    # （「我的项目」那个列表）得自己一个索引。
    op.create_index(
        "ix_task_assignees_user",
        "task_assignees",
        ["user_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_task_assignees_user", "task_assignees", schema=SCHEMA)
    op.drop_table("task_assignees", schema=SCHEMA)
