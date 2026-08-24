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
        # 生成列：容量上限要按命名空间求和，让 PG 自己算就不可能和 content 漂移。
        sa.Column(
            "size_bytes",
            sa.BigInteger(),
            sa.Computed("octet_length(content)", persisted=True),
            nullable=False,
        ),
        sa.Column("version", sa.BigInteger(), nullable=False),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("updated_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        # 主键的首列就是 namespace，所以「某个命名空间下的全部文件」和按前缀
        # 扫目录都走它，不需要再加索引。
        sa.PrimaryKeyConstraint("namespace", "path"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    # 只删表：schema 是 0002 建的，归它去删。
    op.drop_table("workspace_files", schema=SCHEMA)
