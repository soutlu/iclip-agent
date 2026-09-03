"""iclip.generation_jobs：这次生成是从哪段对话的哪个镜头组发起的

Revision ID: 9b41c7d0e28f
Revises: 3d7e42b8f105
Create Date: 2026-09-02 15:00:00.000000

分镜工作台要按对话、按镜头组列生成记录。两列都可空——命令行直接调接口发起的生成没有
对话，不为某一组发起的没有序号；存量行也就都留空。

不建到 conversations 的外键：对话删了，这次生成花过的钱还得说得清（同 ``api_key_id``）。
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
