"""conversations：用 ``agent_job_runs`` 回填每段对话最近一次 run 与最近活动时间。

Revision ID: 7a2c4e6b9d15
Revises: 2d6f8a1b4c07
Create Date: 2026-09-12 20:00:00.000000

``begin_run`` 自 #115 起没有调用方，``last_run_id`` 再没写过，``updated_at`` 也不随运行推前；
侧栏排序、未读小点与审计的时间筛选都建在这两列上。运行事实一直在 ``agent_runtime.agent_job_runs``
里（``attach_run`` 每次 run 写一行），按 ``started_at`` 取每段对话最近一次回填。#115 之前跑过的行带着
过时的 ``last_run_id``，一并重算，所以不限定 NULL 的行；``updated_at`` 取原值与开跑时刻的较大者，
后来的改名不被压下去。只回填活着的对话，与 ``touch_run`` 同范围。``agent_jobs.conversation_id`` 是文本，
按文本比对，不把它转成 uuid。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "7a2c4e6b9d15"
down_revision: str | None = "2d6f8a1b4c07"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
RUNTIME_SCHEMA = "agent_runtime"
TABLE = "conversations"


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE} AS c
        SET last_run_id = latest.run_id,
            updated_at = GREATEST(c.updated_at, latest.started_at)
        FROM (
            SELECT DISTINCT ON (j.conversation_id) j.conversation_id, r.run_id, r.started_at
            FROM {RUNTIME_SCHEMA}.agent_job_runs AS r
            JOIN {RUNTIME_SCHEMA}.agent_jobs AS j ON j.prompt_id = r.prompt_id
            ORDER BY j.conversation_id, r.started_at DESC, r.run_id DESC
        ) AS latest
        WHERE c.id::text = latest.conversation_id AND c.deleted_at IS NULL
        """
    )


def downgrade() -> None:
    """回填的是本该一直在的运行事实，降级不清掉。"""
