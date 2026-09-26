"""iclip.generation_jobs：删掉 ``updated_at`` 与 ``provider_snapshot``，表到 ADR-0001 §9 的 27 列。

Revision ID: 4acae9f7b988
Revises: fd0a5be42793
Create Date: 2026-09-26 10:00:00.000000

``updated_at`` 没有读者：业务时刻由 ``created_at`` / ``submitted_at`` / ``finished_at`` 表达，队列
按提交时刻判超时。``provider_snapshot`` 里系统读过的只有合成的 ``durationMs``，0018 已经提成
``duration_ms``；剩下的是上游原始回包，只有排障用途，还带着上游的签名地址。排障从此只看
``provider_status`` 与错误码。只删列，不回填、不改写别的列，所以不核对存量。

不可逆的部分：降级把两列加回来，``provider_snapshot`` 为空；``updated_at`` 取三个时刻里最晚的
一个，恢复非空。这是近似值，轮询途中最后一次改状态词的时刻没有留下。时长不丢：``duration_ms``
还在，再往下降过 0018 时由它写回快照的 ``durationMs``。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "4acae9f7b988"
down_revision: str | None = "fd0a5be42793"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"
JOBS = f"{SCHEMA}.{TABLE}"


def upgrade() -> None:
    # 两列上没有索引、约束或默认值，直接删。
    for column in ("updated_at", "provider_snapshot"):
        op.drop_column(TABLE, column, schema=SCHEMA)


def downgrade() -> None:
    """两列加回来：快照为空；``updated_at`` 取已有时刻里最晚的一个，恢复非空。"""

    op.add_column(
        TABLE, sa.Column("provider_snapshot", postgresql.JSONB(), nullable=True), schema=SCHEMA
    )
    op.add_column(
        TABLE, sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True), schema=SCHEMA
    )
    # GREATEST 跳过 NULL：排队中的行取 created_at，提交了没结论的取 submitted_at。
    op.execute(f"UPDATE {JOBS} SET updated_at = GREATEST(created_at, submitted_at, finished_at)")
    op.alter_column(TABLE, "updated_at", nullable=False, schema=SCHEMA)
