"""agent_runtime：新表 ``conversation_usage``，按（对话，模型）累加模型用量。

Revision ID: 39a31edb44da
Revises: 5e8b2d4f7a93
Create Date: 2026-09-15 18:00:00.000000

模型每答一次，harness 的用量台账把四类 token 加到对应行上，不逐次落行。审计按对话汇总，
需求单粒度沿 ``iclip.conversations.task_id`` 拿。``conversation_id`` 与其他运行表一样是文本。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "39a31edb44da"
down_revision: str | None = "5e8b2d4f7a93"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"
TABLE = "conversation_usage"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("conversation_id", sa.Text(), nullable=False),
        sa.Column("model_name", sa.Text(), nullable=False),
        sa.Column("requests", sa.BigInteger(), nullable=False),
        sa.Column("input_tokens", sa.BigInteger(), nullable=False),
        sa.Column("cache_read_tokens", sa.BigInteger(), nullable=False),
        sa.Column("cache_write_tokens", sa.BigInteger(), nullable=False),
        sa.Column("output_tokens", sa.BigInteger(), nullable=False),
        sa.Column("first_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("conversation_id", "model_name"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table(TABLE, schema=SCHEMA)
