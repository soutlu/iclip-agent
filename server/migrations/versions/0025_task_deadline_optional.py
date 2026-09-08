"""需求单期限改为始终可选，去掉「非草稿必须有期限」的检查约束。

Revision ID: 1f6b30a94c72
Revises: 7c8e15d2b604
Create Date: 2026-09-07 15:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "1f6b30a94c72"
down_revision: str | None = "7c8e15d2b604"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
CONSTRAINT = "tasks_deadline_check"


def upgrade() -> None:
    op.drop_constraint(CONSTRAINT, "tasks", schema=SCHEMA, type_="check")


def downgrade() -> None:
    # 约束回来之后，已经存在的无期限非草稿需求单会让这一步失败：降级前须先给它们
    # 补上期限或退回草稿，这里不替调用方猜测该填什么。
    op.create_check_constraint(
        CONSTRAINT,
        "tasks",
        "status = 'draft' OR deadline IS NOT NULL",
        schema=SCHEMA,
    )
