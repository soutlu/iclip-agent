"""iclip.conversations：记下这段对话是从哪段的第几轮分叉来的。

Revision ID: 7c4a91e2b5d8
Revises: 39a31edb44da
Create Date: 2026-09-16 10:00:00.000000

两列同时为空或同时非空：不是分叉来的对话两列都空。外键用 restrict，源对话的行永不硬删，
被分叉过的行也不该因为别处的删除动作消失。审计按这两列把副本排除出报表。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "7c4a91e2b5d8"
down_revision: str | None = "39a31edb44da"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "conversations"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("forked_from", sa.Uuid(), nullable=True), schema=SCHEMA)
    op.add_column(TABLE, sa.Column("fork_turn", sa.Integer(), nullable=True), schema=SCHEMA)
    op.create_foreign_key(
        "fk_conversations_forked_from",
        TABLE,
        TABLE,
        ["forked_from"],
        ["id"],
        source_schema=SCHEMA,
        referent_schema=SCHEMA,
        ondelete="restrict",
    )
    op.create_check_constraint(
        "ck_conversations_fork_pair",
        TABLE,
        "(forked_from IS NULL) = (fork_turn IS NULL) AND (fork_turn IS NULL OR fork_turn > 0)",
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_constraint("ck_conversations_fork_pair", TABLE, type_="check", schema=SCHEMA)
    op.drop_constraint("fk_conversations_forked_from", TABLE, type_="foreignkey", schema=SCHEMA)
    op.drop_column(TABLE, "fork_turn", schema=SCHEMA)
    op.drop_column(TABLE, "forked_from", schema=SCHEMA)
