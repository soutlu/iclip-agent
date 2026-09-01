"""iclip.conversations.title_kind：这个标题是默认的、生成的，还是用户自己起的

Revision ID: 4c8e1b70d925
Revises: 2f6c93a1d874
Create Date: 2026-09-01 07:10:00.000000

标题只自动生成一次，之后再不覆盖；用户自己改过的更是碰都不碰。分不出这三者的话，
每一轮跑完都会把用户刚起的名字重新盖掉。

存量行按当下的标题回填：还叫默认名的当作没起过（``default``），其余都是用户自己
起的（``custom``）——这一列是新加的，之前不存在自动生成这条路。
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
