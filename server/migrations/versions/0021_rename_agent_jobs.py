"""agent_runtime：prompts / prompt_runs 表改名

Revision ID: 3d7e42b8f105
Revises: 8a1c5e39b742
Create Date: 2026-09-02 11:00:00.000000

使用 RENAME 保留数据，将表改名为 agent_jobs / agent_job_runs。
Postgres 不自动更新索引与主键约束名称，须同步改名。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3d7e42b8f105"
down_revision: str | None = "8a1c5e39b742"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"

_INDEXES = (
    ("uq_prompts_one_running_per_conversation", "uq_agent_jobs_one_running_per_conversation"),
    ("idx_prompts_queue", "idx_agent_jobs_queue"),
    ("idx_prompts_lease", "idx_agent_jobs_lease"),
    ("idx_prompt_runs_prompt", "idx_agent_job_runs_prompt"),
)

_CONSTRAINTS = (
    ("agent_jobs", "prompts_pkey", "agent_jobs_pkey"),
    ("agent_job_runs", "prompt_runs_pkey", "agent_job_runs_pkey"),
)


def upgrade() -> None:
    op.rename_table("prompts", "agent_jobs", schema=SCHEMA)
    op.rename_table("prompt_runs", "agent_job_runs", schema=SCHEMA)
    for old, new in _INDEXES:
        op.execute(sa.text(f"ALTER INDEX {SCHEMA}.{old} RENAME TO {new}"))
    for table, old, new in _CONSTRAINTS:
        op.execute(sa.text(f"ALTER TABLE {SCHEMA}.{table} RENAME CONSTRAINT {old} TO {new}"))


def downgrade() -> None:
    for table, old, new in _CONSTRAINTS:
        op.execute(sa.text(f"ALTER TABLE {SCHEMA}.{table} RENAME CONSTRAINT {new} TO {old}"))
    for old, new in _INDEXES:
        op.execute(sa.text(f"ALTER INDEX {SCHEMA}.{new} RENAME TO {old}"))
    op.rename_table("agent_job_runs", "prompt_runs", schema=SCHEMA)
    op.rename_table("agent_jobs", "prompts", schema=SCHEMA)
