"""iclip.generation_jobs：需求单归属与水印版地址

Revision ID: 4a9c2f7e6d13
Revises: 7d2e5b9c41af
Create Date: 2026-09-09 10:00:00.000000

需求单 id 是调用方给的归属标签，落列供筛选，不建外键。水印版地址是视频成功时上游
给的第二份产物。存量行两列留空；请求 JSON 改了形状的旧行不迁移，由人清掉。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4a9c2f7e6d13"
down_revision: str | None = "7d2e5b9c41af"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.add_column("generation_jobs", sa.Column("task_id", sa.Uuid(), nullable=True), schema=SCHEMA)
    op.add_column(
        "generation_jobs",
        sa.Column("watermark_output_url", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_generation_jobs_task_created",
        "generation_jobs",
        ["task_id", "created_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_generation_jobs_task_created", table_name="generation_jobs", schema=SCHEMA)
    op.drop_column("generation_jobs", "watermark_output_url", schema=SCHEMA)
    op.drop_column("generation_jobs", "task_id", schema=SCHEMA)
