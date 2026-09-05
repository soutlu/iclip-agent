"""agent_runtime.prompt_runs：消息与运行映射

Revision ID: 6e3f8a21c95b
Revises: 9d4b7c1f6a28
Create Date: 2026-09-01 14:20:00.000000

transcript 通过映射将同一消息的多次 run 合并为一轮。
回填时每个 run 取 created_at 最早的消息，以排除运行中递入的插话。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "6e3f8a21c95b"
down_revision: str | None = "9d4b7c1f6a28"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.create_table(
        "prompt_runs",
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("prompt_id", sa.Text(), nullable=False),
        sa.Column("started_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("run_id"),
        schema=SCHEMA,
    )
    op.create_index("idx_prompt_runs_prompt", "prompt_runs", ["prompt_id"], schema=SCHEMA)
    op.execute(
        sa.text(
            f"INSERT INTO {SCHEMA}.prompt_runs (run_id, prompt_id, started_at) "
            f"SELECT DISTINCT ON (run_id) run_id, prompt_id, created_at "
            f"FROM {SCHEMA}.prompts WHERE run_id IS NOT NULL "
            "ORDER BY run_id, created_at, prompt_id"
        )
    )


def downgrade() -> None:
    op.drop_index("idx_prompt_runs_prompt", table_name="prompt_runs", schema=SCHEMA)
    op.drop_table("prompt_runs", schema=SCHEMA)
