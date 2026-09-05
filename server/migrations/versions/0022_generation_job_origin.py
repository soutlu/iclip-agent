"""iclip.generation_jobs：生成来源

Revision ID: 9b41c7d0e28f
Revises: 3d7e42b8f105
Create Date: 2026-09-02 15:00:00.000000

来源会话与镜头组序号均可空，支持无会话或镜头组的生成；存量行保留空值。
不建 conversations 外键，避免删除会话影响生成审计记录。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "9b41c7d0e28f"
down_revision: str | None = "3d7e42b8f105"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.add_column(
        "generation_jobs", sa.Column("conversation_id", sa.Uuid(), nullable=True), schema=SCHEMA
    )
    op.add_column(
        "generation_jobs", sa.Column("shot_index", sa.Integer(), nullable=True), schema=SCHEMA
    )
    op.create_index(
        "ix_generation_jobs_conversation_created",
        "generation_jobs",
        ["conversation_id", "created_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_generation_jobs_conversation_created", "generation_jobs", schema=SCHEMA)
    op.drop_column("generation_jobs", "shot_index", schema=SCHEMA)
    op.drop_column("generation_jobs", "conversation_id", schema=SCHEMA)
