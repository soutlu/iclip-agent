"""iclip.conversations：记下属主什么时候标记这活儿收尾了。

Revision ID: 8d1c5f26ba34
Revises: 4b6f18c3ea70
Create Date: 2026-09-18 10:00:00.000000

「完成」是属主的判断，不是引擎推出来的运行状态（决策见 docs/adr/0031-conversation-completion-flag.md）。
一列可空时间戳就够：有值即已标记，抹回 NULL 即取消，与 ``deleted_at`` 同一套写法。可空列不回填、
不扫表；老对话一律为空，也就是都没标过。不建索引：按它筛列表时走属主那条索引再过滤，当前量级足够。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8d1c5f26ba34"
down_revision: str | None = "4b6f18c3ea70"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "conversations"
COLUMN = "completed_at"


def upgrade() -> None:
    op.add_column(
        TABLE,
        sa.Column(COLUMN, sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column(TABLE, COLUMN, schema=SCHEMA)
