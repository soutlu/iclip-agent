"""agent_runtime：官方 StepPersistence 的幂等键列与键表

Revision ID: 8a1c5e39b742
Revises: 5f2a9c60d417
Create Date: 2026-09-02 08:00:00.000000

``runs.registration_id`` 记下是哪一次注册占下这个 run_id：重放同一次注册时官方直接返回，
换了一次才判成 run_id 撞车。``events`` / ``snapshots`` 的 ``idempotency_key`` 是边界的稳定
身份，重放同一个边界时把重复的追加与保存挡掉。

``snapshot_idempotency_keys`` 单独存一份键，**不随快照修剪一起删**：修剪掉的那次保存在重放
里仍要被认出来，键跟着快照行一起没了的话，重放会把同一份快照再写一遍。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8a1c5e39b742"
down_revision: str | None = "5f2a9c60d417"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"
EVENTS_INDEX = "idx_events_idempotency"


def upgrade() -> None:
    op.add_column("runs", sa.Column("registration_id", sa.Text(), nullable=True), schema=SCHEMA)

    op.add_column("events", sa.Column("idempotency_key", sa.Text(), nullable=True), schema=SCHEMA)
    op.create_index(
        EVENTS_INDEX,
        "events",
        ["run_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
        schema=SCHEMA,
    )

    op.add_column(
        "snapshots", sa.Column("idempotency_key", sa.Text(), nullable=True), schema=SCHEMA
    )

    op.create_table(
        "snapshot_idempotency_keys",
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("run_id", "idempotency_key"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("snapshot_idempotency_keys", schema=SCHEMA)
    op.drop_column("snapshots", "idempotency_key", schema=SCHEMA)
    op.drop_index(EVENTS_INDEX, table_name="events", schema=SCHEMA)
    op.drop_column("events", "idempotency_key", schema=SCHEMA)
    op.drop_column("runs", "registration_id", schema=SCHEMA)
