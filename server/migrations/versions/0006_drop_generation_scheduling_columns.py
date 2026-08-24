"""iclip.generation_jobs：去掉排期用的四列

Revision ID: c2a86e5b41f7
Revises: b7f3c1d90a24
Create Date: 2026-08-24 18:30:00.000000

排期搬到 procrastinate 之后这四列没人写也没人读了：``attempts`` / ``next_attempt_at``
是「试了几次、下次几点」，``lease_owner`` / ``lease_expires_at`` 是「谁在处理它」。同
一件事在两个地方各存一份只会分叉——现在只有 ``procrastinate_jobs`` 说得清。

那条部分索引一起走：它索的就是 ``next_attempt_at``。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c2a86e5b41f7"
down_revision: str | None = "b7f3c1d90a24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def upgrade() -> None:
    op.drop_index("ix_generation_jobs_due", "generation_jobs", schema=SCHEMA)
    for column in ("attempts", "next_attempt_at", "lease_owner", "lease_expires_at"):
        op.drop_column("generation_jobs", column, schema=SCHEMA)


def downgrade() -> None:
    """加回来。

    ``attempts`` / ``next_attempt_at`` 原本是 NOT NULL，而已有的行没有值可填，所以
    带上默认值补齐——回退一个已经跑起来的库，这两列的历史值本来也找不回来了。
    """

    op.add_column(
        "generation_jobs",
        sa.Column("attempts", sa.BigInteger(), nullable=False, server_default="0"),
        schema=SCHEMA,
    )
    op.add_column(
        "generation_jobs",
        sa.Column(
            "next_attempt_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        schema=SCHEMA,
    )
    op.add_column(
        "generation_jobs",
        sa.Column("lease_owner", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "generation_jobs",
        sa.Column("lease_expires_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_generation_jobs_due",
        "generation_jobs",
        ["next_attempt_at"],
        schema=SCHEMA,
        postgresql_where=sa.text("status NOT IN ('completed', 'failed')"),
    )
