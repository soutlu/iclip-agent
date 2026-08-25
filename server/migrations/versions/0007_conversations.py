"""iclip.conversations：对话表

Revision ID: d9c4a72e3b18
Revises: c2a86e5b41f7
Create Date: 2026-08-24 21:00:00.000000

在这张表出现之前，「一段对话」只是客户端在请求体里给的一个字符串，服务端收下就用、
从不记录。于是「我有哪些对话」「这段对话叫什么」「把它删了」一个都答不上来，而且换
一个字符串就能凭空多出一段对话。

``agent_id`` 故意没有外键：agent 是配置文件里声明的，库里没有对应的行。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d9c4a72e3b18"
down_revision: str | None = "c2a86e5b41f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_user_id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        # 客户端为最近一次运行铸造的那个 id。没发过消息时为空。
        sa.Column("last_run_id", sa.Text(), nullable=True),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("updated_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["owner_user_id"], [f"{SCHEMA}.users.id"], ondelete="cascade"),
        schema=SCHEMA,
    )
    # 列表页就这一个查询：我的对话，最近活动的排前面。首列是属主，所以不用再单独
    # 给 owner_user_id 建索引。
    op.create_index(
        "ix_conversations_owner_recent",
        "conversations",
        ["owner_user_id", sa.text("updated_at DESC")],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_owner_recent", table_name="conversations", schema=SCHEMA)
    op.drop_table("conversations", schema=SCHEMA)
