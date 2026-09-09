"""基线：`iclip` 与 `agent_runtime` 两个 schema 的全部表、procrastinate 3.9.0 的调度表，以及爆款视频快照。

Revision ID: c5d8a2f47e19
Revises:
Create Date: 2026-09-09 12:00:00.000000

id 沿用压缩前链尾的那一份：已经升到链尾的库直接算在基线上，`alembic upgrade head` 不再动它。
表的形状以各模块的 SQLAlchemy 元数据为准（业务表在 domains/*/infra_sql.py，运行表在 harness/
与 platform/ 的存储实现里），本文件只是把它们落成 DDL；表与列的对账见
tests/integration_no_llm/bootstrap/test_migrations.py。
"""

from __future__ import annotations

import csv
import datetime as dt
from collections.abc import Sequence
from decimal import Decimal
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c5d8a2f47e19"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
RUNTIME_SCHEMA = "agent_runtime"

_DATA = Path(__file__).resolve().parent.parent / "data"
PROCRASTINATE_SQL = _DATA / "procrastinate_3.9.0_schema.sql"
"""procrastinate 3.9.0 的 sql/schema.sql 原文。表装在 public，升级依赖时拿上游 migrations/ 追加新迁移。"""

PROCRASTINATE_STATEMENTS = 42
"""上面那份 SQL 应切出的语句数，执行前先核对，切分错了立即失败。"""

INSPIRATION_SEED = _DATA / "inspiration_videos.csv"
"""爆款视频快照：2026-09-08 从数仓与 BDE 离线解析，只收有 OSS 副本且款号能对到 PDM 的行。
运行时不连外部库；刷新数据的办法是替换 CSV 并追加新迁移，不做增量。"""


def upgrade() -> None:
    _create_identity_tables()
    _create_business_tables()
    _create_agent_runtime_tables()
    _install_procrastinate()
    _load_inspiration_snapshot()


def downgrade() -> None:
    """回到空库：只留 env.py 建的 iclip schema 与版本表。"""

    for statement in _PROCRASTINATE_DROPS:
        op.execute(statement)
    op.execute(f"DROP SCHEMA {RUNTIME_SCHEMA} CASCADE")
    tables = ", ".join(f"{SCHEMA}.{name}" for name in _BUSINESS_TABLES)
    op.execute(f"DROP TABLE {tables} CASCADE")


# iclip：账号


def _create_identity_tables() -> None:
    """fastapi-users 的三张表，users 上加本系统的资料与授权列。"""

    op.create_table(
        "users",
        sa.Column("username", sa.String(length=150), nullable=True),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("avatar_url", sa.String(length=1024), nullable=False),
        sa.Column("roles", postgresql.JSONB(), nullable=False),
        sa.Column("direct_permissions", postgresql.JSONB(), nullable=False),
        sa.Column("city", sa.String(length=255), nullable=False),
        sa.Column("job_title", sa.String(length=255), nullable=False),
        sa.Column("departments", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("hashed_password", sa.String(length=1024), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("is_superuser", sa.Boolean(), nullable=False),
        sa.Column("is_verified", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("username"),
        schema=SCHEMA,
    )
    op.create_index("ix_iclip_users_email", "users", ["email"], unique=True, schema=SCHEMA)

    op.create_table(
        "oauth_accounts",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("oauth_name", sa.String(length=100), nullable=False),
        sa.Column("access_token", sa.String(length=1024), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=True),
        sa.Column("refresh_token", sa.String(length=1024), nullable=True),
        sa.Column("account_id", sa.String(length=320), nullable=False),
        sa.Column("account_email", sa.String(length=320), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], [f"{SCHEMA}.users.id"], ondelete="cascade"),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_iclip_oauth_accounts_account_id", "oauth_accounts", ["account_id"], schema=SCHEMA
    )
    op.create_index(
        "ix_iclip_oauth_accounts_oauth_name", "oauth_accounts", ["oauth_name"], schema=SCHEMA
    )
    op.create_index("ix_iclip_oauth_accounts_user_id", "oauth_accounts", ["user_id"], schema=SCHEMA)

    # API key 只存哈希与展示前缀，明文只在签发时出现一次。
    op.create_table(
        "api_keys",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("token_prefix", sa.String(length=24), nullable=False),
        sa.Column("permissions", postgresql.JSONB(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], [f"{SCHEMA}.users.id"], ondelete="cascade"),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_index("ix_iclip_api_keys_owner_user_id", "api_keys", ["owner_user_id"], schema=SCHEMA)
    op.create_index(
        "ix_iclip_api_keys_token_hash", "api_keys", ["token_hash"], unique=True, schema=SCHEMA
    )


# iclip：业务


def _create_business_tables() -> None:
    """指向 users 的外键分两类：属主私有的（对话、生成任务）随账号级联删除；
    有存档价值的（合集、需求单、认领、素材）用 RESTRICT 挡住删号。"""

    op.create_table(
        "collections",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_user_id"], [f"{SCHEMA}.users.id"], ondelete="restrict"),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_collections_owner_recent",
        "collections",
        ["owner_user_id", sa.text("updated_at DESC")],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_collections_updated", "collections", [sa.text("updated_at DESC")], schema=SCHEMA
    )

    op.create_table(
        "tasks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("deadline", sa.DateTime(timezone=True), nullable=True),
        sa.Column("creator_user_id", sa.Uuid(), nullable=False),
        sa.Column("inputs", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("jsonb_typeof(inputs) = 'object'", name="tasks_inputs_object_check"),
        sa.CheckConstraint(
            "status IN ('draft', 'published', 'confirmed', 'withdrawn')", name="tasks_status_check"
        ),
        sa.ForeignKeyConstraint(["creator_user_id"], [f"{SCHEMA}.users.id"], ondelete="restrict"),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_index("ix_tasks_updated", "tasks", [sa.text("updated_at DESC")], schema=SCHEMA)

    # 联合主键防重复认领；撤回的需求单也保留认领记录。
    op.create_table(
        "task_assignees",
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], [f"{SCHEMA}.tasks.id"], ondelete="cascade"),
        sa.ForeignKeyConstraint(["user_id"], [f"{SCHEMA}.users.id"], ondelete="restrict"),
        sa.PrimaryKeyConstraint("task_id", "user_id"),
        schema=SCHEMA,
    )
    op.create_index("ix_task_assignees_user", "task_assignees", ["user_id"], schema=SCHEMA)

    op.create_table(
        "conversations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_user_id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("title_kind", sa.Text(), server_default="default", nullable=False),
        sa.Column("last_run_id", sa.Text(), nullable=True),
        sa.Column("task_id", sa.Uuid(), nullable=True),
        sa.Column("collection_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "title_kind IN ('default', 'generated', 'custom')", name="ck_conversations_title_kind"
        ),
        sa.ForeignKeyConstraint(
            ["collection_id"], [f"{SCHEMA}.collections.id"], ondelete="set null"
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], [f"{SCHEMA}.users.id"], ondelete="cascade"),
        sa.ForeignKeyConstraint(["task_id"], [f"{SCHEMA}.tasks.id"], ondelete="set null"),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_conversations_owner_recent",
        "conversations",
        ["owner_user_id", sa.text("updated_at DESC")],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_conversations_collection",
        "conversations",
        ["collection_id", sa.text("updated_at DESC")],
        postgresql_where=sa.text("collection_id IS NOT NULL"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_conversations_task",
        "conversations",
        ["task_id", "created_at"],
        postgresql_where=sa.text("task_id IS NOT NULL"),
        schema=SCHEMA,
    )
    # 治理者跨属主复盘全部对话，用 (updated_at, id) 游标分页。
    op.create_index(
        "ix_conversations_updated",
        "conversations",
        [sa.text("updated_at DESC"), sa.text("id DESC")],
        schema=SCHEMA,
    )

    # 用过的对话 id 永久占住：对话删了运行历史还在，id 不能再发给别人。
    op.create_table(
        "conversation_ids",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )

    # api_key_id、conversation_id、task_id 不建外键：密钥、对话、需求单删了之后，
    # 生成记录还要能对回去。
    op.create_table(
        "generation_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_user_id", sa.Uuid(), nullable=False),
        sa.Column("api_key_id", sa.Uuid(), nullable=True),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column("shot_index", sa.Integer(), nullable=True),
        sa.Column("task_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("request", postgresql.JSONB(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("provider_task_id", sa.Text(), nullable=True),
        sa.Column("provider_status", sa.Text(), nullable=True),
        sa.Column("provider_snapshot", postgresql.JSONB(), nullable=True),
        sa.Column("output_url", sa.Text(), nullable=True),
        sa.Column("watermark_output_url", sa.Text(), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["owner_user_id"], [f"{SCHEMA}.users.id"], ondelete="cascade"),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_generation_jobs_owner_created",
        "generation_jobs",
        ["owner_user_id", "created_at"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_generation_jobs_conversation_created",
        "generation_jobs",
        ["conversation_id", "created_at"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_generation_jobs_task_created",
        "generation_jobs",
        ["task_id", "created_at"],
        schema=SCHEMA,
    )

    # 存 object key 不存 URL，换 CDN 域名不用迁数据；key 由 assetId 派生，唯一约束防重复登记。
    op.create_table(
        "media_assets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("creator_user_id", sa.Uuid(), nullable=False),
        sa.Column("api_key_id", sa.Uuid(), nullable=True),
        sa.Column("asset_type", sa.Text(), nullable=False),
        sa.Column("object_key", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("asset_type IN ('image', 'video')", name="media_assets_type_check"),
        sa.CheckConstraint("size_bytes > 0", name="media_assets_size_check"),
        sa.ForeignKeyConstraint(["creator_user_id"], [f"{SCHEMA}.users.id"], ondelete="restrict"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("object_key"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_media_assets_created", "media_assets", [sa.text("created_at DESC")], schema=SCHEMA
    )


_BUSINESS_TABLES = (
    "media_assets",
    "generation_jobs",
    "conversation_ids",
    "conversations",
    "task_assignees",
    "tasks",
    "collections",
    "inspiration_videos",
    "api_keys",
    "oauth_accounts",
    "users",
)


# agent_runtime：运行事实


def _create_agent_runtime_tables() -> None:
    op.execute(f"CREATE SCHEMA IF NOT EXISTS {RUNTIME_SCHEMA}")

    # runs / events / snapshots / tool_effects / media 严格镜像官方 harness StepPersistence
    # 的 Sqlite 表形状，列不增不减。
    op.create_table(
        "runs",
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("conversation_id", sa.Text(), nullable=True),
        sa.Column("parent_run_id", sa.Text(), nullable=True),
        sa.Column("agent_name", sa.Text(), nullable=True),
        sa.Column("metadata", sa.Text(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("registration_id", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("run_id"),
        schema=RUNTIME_SCHEMA,
    )
    op.create_index("idx_runs_conv", "runs", ["conversation_id"], schema=RUNTIME_SCHEMA)
    op.create_index("idx_runs_parent", "runs", ["parent_run_id"], schema=RUNTIME_SCHEMA)
    op.create_index("idx_runs_started", "runs", ["started_at"], schema=RUNTIME_SCHEMA)

    op.create_table(
        "events",
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("conversation_id", sa.Text(), nullable=True),
        sa.Column("parent_run_id", sa.Text(), nullable=True),
        sa.Column("agent_name", sa.Text(), nullable=True),
        sa.Column("tool_call_id", sa.Text(), nullable=True),
        sa.Column("tool_name", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("metadata", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("seq"),
        schema=RUNTIME_SCHEMA,
    )
    op.create_index("idx_events_run", "events", ["run_id", "seq"], schema=RUNTIME_SCHEMA)
    op.create_index(
        "idx_events_idempotency",
        "events",
        ["run_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
        schema=RUNTIME_SCHEMA,
    )

    op.create_table(
        "snapshots",
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("conversation_id", sa.Text(), nullable=True),
        sa.Column("parent_run_id", sa.Text(), nullable=True),
        sa.Column("agent_name", sa.Text(), nullable=True),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.Text(), server_default="complete", nullable=False),
        sa.Column("messages", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("seq"),
        schema=RUNTIME_SCHEMA,
    )
    op.create_index("idx_snapshots_run", "snapshots", ["run_id", "seq"], schema=RUNTIME_SCHEMA)

    op.create_table(
        "snapshot_idempotency_keys",
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("run_id", "idempotency_key"),
        schema=RUNTIME_SCHEMA,
    )

    op.create_table(
        "tool_effects",
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("tool_call_id", sa.Text(), nullable=False),
        sa.Column("tool_name", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("idempotency_key", sa.Text(), nullable=True),
        sa.Column("effect_summary", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("run_id", "tool_call_id"),
        schema=RUNTIME_SCHEMA,
    )

    op.create_table(
        "media",
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("media_type", sa.Text(), nullable=True),
        sa.Column("bytes", sa.LargeBinary(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("metadata", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("sha256"),
        schema=RUNTIME_SCHEMA,
    )

    # 消息队列：同一对话同时只能有一条在跑或在等审批，靠部分唯一索引卡死。
    op.create_table(
        "agent_jobs",
        sa.Column("prompt_id", sa.Text(), nullable=False),
        sa.Column("conversation_id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("owner_user_id", sa.Uuid(), nullable=False),
        sa.Column("user_name", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("run_id", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("steered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("locked_by", sa.Text(), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("interrupt_reason", sa.Text(), nullable=True),
        sa.Column("attempt", sa.Integer(), server_default="0", nullable=False),
        sa.Column("decisions", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("prompt_id"),
        schema=RUNTIME_SCHEMA,
    )
    op.create_index(
        "uq_agent_jobs_one_running_per_conversation",
        "agent_jobs",
        ["conversation_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('running', 'awaiting')"),
        schema=RUNTIME_SCHEMA,
    )
    op.create_index(
        "idx_agent_jobs_queue",
        "agent_jobs",
        ["conversation_id", "created_at"],
        schema=RUNTIME_SCHEMA,
    )
    op.create_index(
        "idx_agent_jobs_lease",
        "agent_jobs",
        ["heartbeat_at"],
        postgresql_where=sa.text("status = 'running'"),
        schema=RUNTIME_SCHEMA,
    )

    op.create_table(
        "agent_job_runs",
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("prompt_id", sa.Text(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("run_id"),
        schema=RUNTIME_SCHEMA,
    )
    op.create_index(
        "idx_agent_job_runs_prompt", "agent_job_runs", ["prompt_id"], schema=RUNTIME_SCHEMA
    )

    op.create_table(
        "workspace_files",
        sa.Column("namespace", sa.Text(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        # 容量由内容算出来，配额统计不用再读正文。
        sa.Column(
            "size_bytes",
            sa.BigInteger(),
            sa.Computed("octet_length(content)", persisted=True),
            nullable=False,
        ),
        sa.Column("version", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("namespace", "path"),
        schema=RUNTIME_SCHEMA,
    )

    op.create_table(
        "materials",
        sa.Column("namespace", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("namespace", "url"),
        schema=RUNTIME_SCHEMA,
    )


# public：procrastinate 调度表


def _install_procrastinate() -> None:
    statements = _split_statements(PROCRASTINATE_SQL.read_text(encoding="utf-8"))
    if len(statements) != PROCRASTINATE_STATEMENTS:
        raise RuntimeError(f"切出了 {len(statements)} 条语句，应该是 {PROCRASTINATE_STATEMENTS} 条")
    bind = op.get_bind()
    for statement in statements:
        # 原生执行：SQLAlchemy 的 text() 会把 PostgreSQL 的 :: 转换语法当成绑定参数。
        bind.exec_driver_sql(statement)


def _split_statements(sql: str) -> list[str]:
    """按分号切语句，$$ 包着的函数体整块保留；asyncpg 一次只吃一条语句。

    只适用于冻结的这份 SQL：美元引号只有 $$，注释和字符串里没有分号。
    """

    statements: list[str] = []
    buffer: list[str] = []
    inside_body = False
    for chunk in sql.split("$$"):
        if inside_body:
            buffer.append(f"$${chunk}$$")
        else:
            *complete, remainder = chunk.split(";")
            for piece in complete:
                buffer.append(piece)
                statement = "".join(buffer).strip()
                if statement:
                    statements.append(statement)
                buffer = []
            buffer.append(remainder)
        inside_body = not inside_body
    tail = "".join(buffer).strip()
    if tail:
        statements.append(tail)
    return statements


_PROCRASTINATE_DROPS = (
    "DROP TABLE IF EXISTS procrastinate_events CASCADE",
    "DROP TABLE IF EXISTS procrastinate_periodic_defers CASCADE",
    "DROP TABLE IF EXISTS procrastinate_jobs CASCADE",
    "DROP TABLE IF EXISTS procrastinate_workers CASCADE",
    "DROP FUNCTION IF EXISTS procrastinate_defer_jobs_v1(procrastinate_job_to_defer_v1[])",
    "DROP FUNCTION IF EXISTS procrastinate_defer_periodic_job_v2(character varying, character varying, character varying, character varying, integer, character varying, bigint, jsonb)",
    "DROP FUNCTION IF EXISTS procrastinate_fetch_job_v2(character varying[], bigint)",
    "DROP FUNCTION IF EXISTS procrastinate_finish_job_v1(bigint, procrastinate_job_status, boolean)",
    "DROP FUNCTION IF EXISTS procrastinate_cancel_job_v1(bigint, boolean, boolean)",
    "DROP FUNCTION IF EXISTS procrastinate_retry_job_v1(bigint, timestamp with time zone, integer, character varying, character varying)",
    "DROP FUNCTION IF EXISTS procrastinate_retry_job_v2(bigint, timestamp with time zone, integer, character varying, character varying)",
    "DROP FUNCTION IF EXISTS procrastinate_notify_queue_job_inserted_v1()",
    "DROP FUNCTION IF EXISTS procrastinate_notify_queue_abort_job_v1()",
    "DROP FUNCTION IF EXISTS procrastinate_trigger_function_status_events_insert_v1()",
    "DROP FUNCTION IF EXISTS procrastinate_trigger_function_status_events_update_v1()",
    "DROP FUNCTION IF EXISTS procrastinate_trigger_function_scheduled_events_v1()",
    "DROP FUNCTION IF EXISTS procrastinate_trigger_abort_requested_events_procedure_v1()",
    "DROP FUNCTION IF EXISTS procrastinate_unlink_periodic_defers_v1()",
    "DROP FUNCTION IF EXISTS procrastinate_register_worker_v1()",
    "DROP FUNCTION IF EXISTS procrastinate_unregister_worker_v1(bigint)",
    "DROP FUNCTION IF EXISTS procrastinate_update_heartbeat_v1(bigint)",
    "DROP FUNCTION IF EXISTS procrastinate_prune_stalled_workers_v1(float)",
    "DROP TYPE IF EXISTS procrastinate_job_status",
    "DROP TYPE IF EXISTS procrastinate_job_event_type",
    "DROP TYPE IF EXISTS procrastinate_job_to_defer_v1",
)


# iclip：爆款视频快照


def _load_inspiration_snapshot() -> None:
    table = op.create_table(
        "inspiration_videos",
        sa.Column("video_id", sa.Text(), nullable=False),
        # 数仓原样给的编号永不改写，出问题时它是唯一能对回源头的线索。
        sa.Column("style_raw", sa.Text(), nullable=False),
        sa.Column("style_no", sa.Text(), nullable=False),
        sa.Column("category_id", sa.Integer(), nullable=False),
        sa.Column("category_name", sa.Text(), nullable=False),
        sa.Column("brand_code", sa.Text(), nullable=False),
        sa.Column("brand_name", sa.Text(), nullable=False),
        sa.Column("oss_url", sa.Text(), nullable=False),
        sa.Column("posted_date", sa.Date(), nullable=True),
        sa.Column("impressions", sa.BigInteger(), nullable=False),
        sa.Column("views", sa.BigInteger(), nullable=False),
        sa.Column("clicks", sa.BigInteger(), nullable=False),
        sa.Column("orders", sa.BigInteger(), nullable=False),
        sa.Column("revenue", sa.Numeric(), nullable=False),
        sa.PrimaryKeyConstraint("video_id"),
        schema=SCHEMA,
    )
    # 精确匹配走 style_no；找替身按 (品类, 品牌) 与品类两级收窄。
    op.create_index(
        "ix_inspiration_videos_style_no", "inspiration_videos", ["style_no"], schema=SCHEMA
    )
    op.create_index(
        "ix_inspiration_videos_category_brand",
        "inspiration_videos",
        ["category_id", "brand_code"],
        schema=SCHEMA,
    )
    op.bulk_insert(table, _seed_rows())


def _seed_rows() -> list[dict[str, object]]:
    """读随仓库分发的快照；缺文件即失败，不静默建空表。"""

    with INSPIRATION_SEED.open(encoding="utf-8", newline="") as handle:
        return [
            {
                "video_id": row["video_id"],
                "style_raw": row["style_raw"],
                "style_no": row["style_no"],
                "category_id": int(row["category_id"]),
                "category_name": row["category_name"],
                "brand_code": row["brand_code"],
                "brand_name": row["brand_name"],
                "oss_url": row["oss_url"],
                "posted_date": (
                    dt.date.fromisoformat(row["posted_date"]) if row["posted_date"] else None
                ),
                "impressions": int(row["impressions"]),
                "views": int(row["views"]),
                "clicks": int(row["clicks"]),
                "orders": int(row["orders"]),
                "revenue": Decimal(row["revenue"]),
            }
            for row in csv.DictReader(handle)
        ]
