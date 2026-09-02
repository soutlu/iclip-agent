"""agent_runtime：prompts 改名 agent_jobs，prompt_runs 改名 agent_job_runs

Revision ID: 3d7e42b8f105
Revises: 8a1c5e39b742
Create Date: 2026-09-02 11:00:00.000000

只改名，不动列，也不动数据：这两张表的行是用户发上来的消息与它们起过的 run。所以一律走
``RENAME``，不走 drop/create。

索引与主键约束不跟着表名走，PG 不会自动改它们，得逐个点名改。
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
