"""iclip.conversations.title_kind：标题来源

Revision ID: 4c8e1b70d925
Revises: 2f6c93a1d874
Create Date: 2026-09-01 07:10:00.000000

区分默认、自动生成和用户自定义标题，防止自动生成覆盖已有标题。
存量默认标题回填 default，其余回填 custom。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4c8e1b70d925"
down_revision: str | None = "2f6c93a1d874"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"

DEFAULT_TITLE = "新对话"


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("title_kind", sa.Text(), nullable=False, server_default="default"),
        schema=SCHEMA,
    )
    op.execute(
        sa.text(
            f"UPDATE {SCHEMA}.conversations SET title_kind = 'custom' WHERE title <> :default_title"
        ).bindparams(default_title=DEFAULT_TITLE)
    )
    op.create_check_constraint(
        "ck_conversations_title_kind",
        "conversations",
        "title_kind IN ('default', 'generated', 'custom')",
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_constraint("ck_conversations_title_kind", "conversations", schema=SCHEMA, type_="check")
    op.drop_column("conversations", "title_kind", schema=SCHEMA)
