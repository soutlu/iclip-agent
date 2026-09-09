"""agent_runtime.agent_jobs：归属标签 user_name

Revision ID: 7d2e5b9c41af
Revises: c3f7a1e94b28
Create Date: 2026-09-08 12:00:00.000000

每条消息记下替谁跑，运行把它带给工具、工具发给上游落表。存量行按属主账号回填，
用户名为空的用邮箱，与审计标签同一取法；找不到属主的行会让收非空这一步报错，
那是数据问题，不静默补值。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "7d2e5b9c41af"
down_revision: str | None = "c3f7a1e94b28"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.add_column("agent_jobs", sa.Column("user_name", sa.Text(), nullable=True), schema=SCHEMA)
    op.execute(
        sa.text(
            f"UPDATE {SCHEMA}.agent_jobs AS j "
            "SET user_name = coalesce(u.username, u.email) "
            "FROM iclip.users AS u WHERE u.id = j.owner_user_id"
        )
    )
    op.alter_column("agent_jobs", "user_name", nullable=False, schema=SCHEMA)


def downgrade() -> None:
    op.drop_column("agent_jobs", "user_name", schema=SCHEMA)
