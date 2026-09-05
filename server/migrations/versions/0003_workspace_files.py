"""agent_runtime.workspace_files：agent 工作区的文件表

Revision ID: a4d7b1c2e903
Revises: c3f81a52d906
Create Date: 2026-08-24 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a4d7b1c2e903"
down_revision: str | None = "c3f81a52d906"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.create_table(
        "workspace_files",
        sa.Column("namespace", sa.Text(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        # 生成列从 content 计算容量，供命名空间配额统计。
        sa.Column(
            "size_bytes",
            sa.BigInteger(),
            sa.Computed("octet_length(content)", persisted=True),
            nullable=False,
        ),
        sa.Column("version", sa.BigInteger(), nullable=False),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("updated_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        # 主键已覆盖 namespace 查询，无需额外索引。
        sa.PrimaryKeyConstraint("namespace", "path"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    # schema 由 0002 创建并负责回退。
    op.drop_table("workspace_files", schema=SCHEMA)
