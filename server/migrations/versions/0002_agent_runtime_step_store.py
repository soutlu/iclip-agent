"""agent_runtime：官方 harness StepPersistence 表（严格镜像 SqliteStepStore/SqliteMediaStore）

Revision ID: c3f81a52d906
Revises: eca15db4a439
Create Date: 2026-08-21 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c3f81a52d906"
down_revision: str | None = "eca15db4a439"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.execute(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}")

    op.create_table(
        "runs",
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("conversation_id", sa.Text(), nullable=True),
        sa.Column("parent_run_id", sa.Text(), nullable=True),
        sa.Column("agent_name", sa.Text(), nullable=True),
        sa.Column("metadata", sa.Text(), nullable=False),
        sa.Column("started_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("run_id"),
        schema=SCHEMA,
    )
    op.create_index("idx_runs_conv", "runs", ["conversation_id"], schema=SCHEMA)
    op.create_index("idx_runs_parent", "runs", ["parent_run_id"], schema=SCHEMA)
    op.create_index("idx_runs_started", "runs", ["started_at"], schema=SCHEMA)

    op.create_table(
        "events",
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("timestamp", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("conversation_id", sa.Text(), nullable=True),
        sa.Column("parent_run_id", sa.Text(), nullable=True),
        sa.Column("agent_name", sa.Text(), nullable=True),
        sa.Column("tool_call_id", sa.Text(), nullable=True),
        sa.Column("tool_name", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("metadata", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("seq"),
        schema=SCHEMA,
    )
    op.create_index("idx_events_run", "events", ["run_id", "seq"], schema=SCHEMA)

    op.create_table(
        "snapshots",
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("conversation_id", sa.Text(), nullable=True),
        sa.Column("parent_run_id", sa.Text(), nullable=True),
        sa.Column("agent_name", sa.Text(), nullable=True),
        sa.Column("timestamp", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("state", sa.Text(), server_default="complete", nullable=False),
        sa.Column("messages", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("seq"),
        schema=SCHEMA,
    )
    op.create_index("idx_snapshots_run", "snapshots", ["run_id", "seq"], schema=SCHEMA)

    op.create_table(
        "tool_effects",
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("tool_call_id", sa.Text(), nullable=False),
        sa.Column("tool_name", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("started_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("ended_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("idempotency_key", sa.Text(), nullable=True),
        sa.Column("effect_summary", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("run_id", "tool_call_id"),
        schema=SCHEMA,
    )

    op.create_table(
        "media",
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("media_type", sa.Text(), nullable=True),
        sa.Column("bytes", sa.LargeBinary(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("metadata", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("sha256"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("media", schema=SCHEMA)
    op.drop_table("tool_effects", schema=SCHEMA)
    op.drop_index("idx_snapshots_run", "snapshots", schema=SCHEMA)
    op.drop_table("snapshots", schema=SCHEMA)
    op.drop_index("idx_events_run", "events", schema=SCHEMA)
    op.drop_table("events", schema=SCHEMA)
    op.drop_index("idx_runs_started", "runs", schema=SCHEMA)
    op.drop_index("idx_runs_parent", "runs", schema=SCHEMA)
    op.drop_index("idx_runs_conv", "runs", schema=SCHEMA)
    op.drop_table("runs", schema=SCHEMA)
    op.execute(f"DROP SCHEMA IF EXISTS {SCHEMA}")
