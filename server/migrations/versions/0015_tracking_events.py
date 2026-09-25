"""iclip：新表 ``tracking_events``，前端发来的埋点事件只追加落在这里。

Revision ID: 44301a1420de
Revises: 3f8d27c1a5e9
Create Date: 2026-09-24 10:00:00.000000

每行一条事件：封闭的事件名、按事件名规定的主语（生成记录或对话，至少一个）、取自主体的
发起用户与 API key、数据库时钟给的发生时刻。审计按表名读下载事件算有效镜。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "44301a1420de"
down_revision: str | None = "3f8d27c1a5e9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "tracking_events"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("api_key_id", sa.Uuid(), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "job_id IS NOT NULL OR conversation_id IS NOT NULL",
            name="ck_tracking_events_subject",
        ),
        sa.ForeignKeyConstraint(
            ["job_id"], [f"{SCHEMA}.generation_jobs.id"], name="fk_tracking_events_job"
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            [f"{SCHEMA}.users.id"],
            name="fk_tracking_events_user",
            ondelete="cascade",
        ),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_index("ix_tracking_events_job", TABLE, ["job_id"], schema=SCHEMA)
    op.create_index(
        "ix_tracking_events_conversation",
        TABLE,
        ["conversation_id", "occurred_at"],
        schema=SCHEMA,
    )
    op.create_index("ix_tracking_events_name", TABLE, ["name", "occurred_at"], schema=SCHEMA)


def downgrade() -> None:
    op.drop_table(TABLE, schema=SCHEMA)
