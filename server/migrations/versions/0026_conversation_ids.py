"""保留已使用的对话 ID，防止删除后重新认领保留的运行历史。

Revision ID: 2b81a3dfe6c4
Revises: 1f6b30a94c72
Create Date: 2026-09-08 08:40:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "2b81a3dfe6c4"
down_revision: str | None = "1f6b30a94c72"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.create_table(
        "conversation_ids",
        sa.Column("id", sa.Uuid(), primary_key=True),
        schema=SCHEMA,
    )
    # 运行历史独立于对话行保留，升级前已经删掉的对话也不能被重新认领。
    # Harness 接受任意字符串会话名；业务 HTTP 只接受 UUID，不保留其他名字。
    op.execute(
        sa.text(
            "INSERT INTO iclip.conversation_ids (id) "
            "SELECT id FROM iclip.conversations "
            "UNION SELECT conversation_id FROM iclip.generation_jobs "
            "WHERE conversation_id IS NOT NULL "
            "UNION SELECT CAST(conversation_id AS uuid) FROM ("
            "SELECT conversation_id FROM agent_runtime.runs "
            "UNION SELECT conversation_id FROM agent_runtime.events "
            "UNION SELECT conversation_id FROM agent_runtime.snapshots "
            "UNION SELECT conversation_id FROM agent_runtime.agent_jobs"
            ") AS history WHERE conversation_id ~* "
            "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"
        )
    )


def downgrade() -> None:
    op.drop_table("conversation_ids", schema=SCHEMA)
