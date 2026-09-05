"""agent_runtime：StepPersistence 幂等键

Revision ID: 8a1c5e39b742
Revises: 5f2a9c60d417
Create Date: 2026-09-02 08:00:00.000000

registration_id 区分注册重放与 run_id 冲突；事件和快照的 idempotency_key 防止重复写入。
snapshot_idempotency_keys 不随快照修剪删除，确保修剪后的保存重放仍能去重。
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
