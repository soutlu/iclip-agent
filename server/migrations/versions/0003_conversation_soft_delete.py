"""conversations：删除改为标记 ``deleted_at``，行留着占住 id；``conversation_ids`` 保留表下线。

Revision ID: 4c7d9e1f2a68
Revises: 8b1f4a2c9d3e
Create Date: 2026-09-12 14:00:00.000000

存量墓碑只在 ``conversation_ids`` 里有一个 id，对话行早没了；属主与 Agent 只能从
``agent_runtime.agent_jobs`` 的票据找回。有票据的补成已删除的对话行，没有任何票据的丢掉：
ADR-0017 挡重用是为了保护运行历史，这些 id 没有历史。属主已不在 ``users`` 的同样丢掉，
否则外键会让整次迁移中断（测试库里就有这种孤儿票据）。决策见 docs/adr/0021-conversation-soft-delete.md。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4c7d9e1f2a68"
down_revision: str | None = "8b1f4a2c9d3e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "conversations"
OWNER_FK = "conversations_owner_user_id_fkey"
"""基线里没起名，Postgres 自动起的名字；重建时同样不起名，名字不变。"""

_INDEXES: tuple[tuple[str, list[str | sa.TextClause], str | None], ...] = (
    ("ix_conversations_owner_recent", ["owner_user_id", sa.text("updated_at DESC")], None),
    ("ix_conversations_updated", [sa.text("updated_at DESC"), sa.text("id DESC")], None),
    ("ix_conversations_task", ["task_id", "created_at"], "task_id IS NOT NULL"),
    (
        "ix_conversations_collection",
        ["collection_id", sa.text("updated_at DESC")],
        "collection_id IS NOT NULL",
    ),
)


def _rebuild_indexes(*, live_only: bool) -> None:
    """四个索引整体重建：``live_only`` 时都只收 ``deleted_at IS NULL`` 的行。"""

    for name, columns, where in _INDEXES:
        op.drop_index(name, table_name=TABLE, schema=SCHEMA)
        clauses = [
            clause for clause in (where, "deleted_at IS NULL" if live_only else None) if clause
        ]
        op.create_index(
            name,
            TABLE,
            columns,
            schema=SCHEMA,
            postgresql_where=sa.text(" AND ".join(clauses)) if clauses else None,
        )


def _swap_owner_fk(*, ondelete: str) -> None:
    op.drop_constraint(OWNER_FK, TABLE, schema=SCHEMA, type_="foreignkey")
    op.create_foreign_key(
        None,
        TABLE,
        "users",
        ["owner_user_id"],
        ["id"],
        source_schema=SCHEMA,
        referent_schema=SCHEMA,
        ondelete=ondelete,
    )


def upgrade() -> None:
    op.add_column(
        TABLE, sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True), schema=SCHEMA
    )
    _swap_owner_fk(ondelete="restrict")
    _rebuild_indexes(live_only=True)
    # 票据表的 conversation_id 是文本：把 uuid 转成文本去比，不把文本转成 uuid，脏数据不会中断迁移。
    op.execute(
        f"""
        INSERT INTO {SCHEMA}.{TABLE}
            (id, owner_user_id, agent_id, title, title_kind, last_run_id, task_id, collection_id,
             created_at, updated_at, deleted_at)
        SELECT r.id, j.owner_user_id, j.agent_id, '已删除的对话', 'default', NULL, NULL, NULL,
               j.first_at, j.last_at, now()
        FROM {SCHEMA}.conversation_ids r
        JOIN (
            SELECT conversation_id,
                   (array_agg(owner_user_id ORDER BY created_at))[1] AS owner_user_id,
                   (array_agg(agent_id ORDER BY created_at))[1] AS agent_id,
                   min(created_at) AS first_at,
                   max(coalesce(finished_at, created_at)) AS last_at
            FROM agent_runtime.agent_jobs
            GROUP BY conversation_id
        ) j ON j.conversation_id = r.id::text
        WHERE NOT EXISTS (SELECT 1 FROM {SCHEMA}.{TABLE} c WHERE c.id = r.id)
          AND EXISTS (SELECT 1 FROM {SCHEMA}.users u WHERE u.id = j.owner_user_id)
        """
    )
    op.drop_table("conversation_ids", schema=SCHEMA)


def downgrade() -> None:
    op.create_table(
        "conversation_ids",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    # 先把所有 id（含墓碑）搬进保留表，再删墓碑行，顺序反了 id 就放出去了。
    op.execute(f"INSERT INTO {SCHEMA}.conversation_ids (id) SELECT id FROM {SCHEMA}.{TABLE}")
    op.execute(f"DELETE FROM {SCHEMA}.{TABLE} WHERE deleted_at IS NOT NULL")
    _rebuild_indexes(live_only=False)
    _swap_owner_fk(ondelete="cascade")
    op.drop_column(TABLE, "deleted_at", schema=SCHEMA)
