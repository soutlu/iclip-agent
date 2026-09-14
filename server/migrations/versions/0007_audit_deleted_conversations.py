"""conversations：审计能查墓碑，游标索引收全部行；墓碑也回填 ``last_run_id``。

Revision ID: 5e8b2d4f7a93
Revises: 7a2c4e6b9d15
Create Date: 2026-09-13 10:00:00.000000

治理者复盘要看属主删掉的对话（决策见 docs/adr/0024-audit-deleted-conversations.md）。审计分页走
``ix_conversations_updated``，它原来只收 ``deleted_at IS NULL`` 的行，查墓碑就没索引可用；这里去掉谓词。
属主视角的三个索引仍只收活行。0006 回填 ``last_run_id`` 时跳过了墓碑，墓碑在 ``state=done`` 下就查不出来，
这一步用同一条规则把它们补上。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5e8b2d4f7a93"
down_revision: str | None = "7a2c4e6b9d15"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
RUNTIME_SCHEMA = "agent_runtime"
TABLE = "conversations"
INDEX = "ix_conversations_updated"


def _rebuild_cursor_index(*, live_only: bool) -> None:
    op.drop_index(INDEX, table_name=TABLE, schema=SCHEMA)
    op.create_index(
        INDEX,
        TABLE,
        [sa.text("updated_at DESC"), sa.text("id DESC")],
        schema=SCHEMA,
        postgresql_where=sa.text("deleted_at IS NULL") if live_only else None,
    )


def upgrade() -> None:
    _rebuild_cursor_index(live_only=False)
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
        WHERE c.id::text = latest.conversation_id AND c.deleted_at IS NOT NULL
        """
    )


def downgrade() -> None:
    """回填的是本该一直在的运行事实，降级不清掉；索引恢复只收活行。"""

    _rebuild_cursor_index(live_only=True)
