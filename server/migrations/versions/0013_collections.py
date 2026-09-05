"""iclip.projects → iclip.collections：合集与属主

Revision ID: 7b1d4e6a92c3
Revises: 5f2a9c41d8b0
Create Date: 2026-08-29 21:30:00.000000

表、索引和约束同步改名；creator_user_id 改为 owner_user_id，作为合集访问边界。
删除 task_projects，已有需求单与项目的关联不迁移；需求单与会话的直接关联保留。
用户直接授权与 API key 授权中的权限字符串均须改名，避免已签发密钥失去权限。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "7b1d4e6a92c3"
down_revision: str | None = "5f2a9c41d8b0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"

_RENAMED_PERMISSIONS = (
    ("projects:read", "collections:read"),
    ("projects:write", "collections:write"),
)


def _rewrite_permissions(pairs: Sequence[tuple[str, str]]) -> None:
    """同步更新用户与 API key 的 JSONB 权限数组。"""

    cases = " ".join(f"WHEN '{old}' THEN '{new}'" for old, new in pairs)
    old_names = ", ".join(f"'{old}'" for old, _ in pairs)
    for table, column in (("users", "direct_permissions"), ("api_keys", "permissions")):
        op.execute(
            sa.text(
                f"""
                UPDATE {SCHEMA}.{table}
                SET {column} = (
                    SELECT jsonb_agg(CASE item {cases} ELSE item END)
                    FROM jsonb_array_elements_text({column}) AS item
                )
                WHERE EXISTS (
                    SELECT 1 FROM jsonb_array_elements_text({column}) AS item
                    WHERE item IN ({old_names})
                )
                """
            )
        )


def upgrade() -> None:
    op.drop_index("ix_task_projects_project", "task_projects", schema=SCHEMA)
    op.drop_table("task_projects", schema=SCHEMA)

    op.rename_table("projects", "collections", schema=SCHEMA)
    op.alter_column(
        "collections", "creator_user_id", new_column_name="owner_user_id", schema=SCHEMA
    )
    op.execute(
        f"ALTER TABLE {SCHEMA}.collections RENAME CONSTRAINT projects_pkey TO collections_pkey"
    )
    op.execute(
        f"ALTER TABLE {SCHEMA}.collections "
        "RENAME CONSTRAINT projects_creator_user_id_fkey TO collections_owner_user_id_fkey"
    )
    op.execute(f"ALTER INDEX {SCHEMA}.ix_projects_updated RENAME TO ix_collections_updated")
    op.create_index(
        "ix_collections_owner_recent",
        "collections",
        ["owner_user_id", sa.text("updated_at DESC")],
        schema=SCHEMA,
    )

    op.alter_column("conversations", "project_id", new_column_name="collection_id", schema=SCHEMA)
    op.execute(
        f"ALTER TABLE {SCHEMA}.conversations "
        "RENAME CONSTRAINT conversations_project_id_fkey TO conversations_collection_id_fkey"
    )
    op.execute(
        f"ALTER INDEX {SCHEMA}.ix_conversations_project RENAME TO ix_conversations_collection"
    )
    # 跨属主审计查询使用 (updated_at, id) 游标分页。
    op.create_index(
        "ix_conversations_updated",
        "conversations",
        [sa.text("updated_at DESC"), sa.text("id DESC")],
        schema=SCHEMA,
    )

    _rewrite_permissions(_RENAMED_PERMISSIONS)


def downgrade() -> None:
    _rewrite_permissions(tuple((new, old) for old, new in _RENAMED_PERMISSIONS))

    op.drop_index("ix_conversations_updated", "conversations", schema=SCHEMA)
    op.execute(
        f"ALTER INDEX {SCHEMA}.ix_conversations_collection RENAME TO ix_conversations_project"
    )
    op.execute(
        f"ALTER TABLE {SCHEMA}.conversations "
        "RENAME CONSTRAINT conversations_collection_id_fkey TO conversations_project_id_fkey"
    )
    op.alter_column("conversations", "collection_id", new_column_name="project_id", schema=SCHEMA)

    op.drop_index("ix_collections_owner_recent", "collections", schema=SCHEMA)
    op.execute(f"ALTER INDEX {SCHEMA}.ix_collections_updated RENAME TO ix_projects_updated")
    op.execute(
        f"ALTER TABLE {SCHEMA}.collections "
        "RENAME CONSTRAINT collections_owner_user_id_fkey TO projects_creator_user_id_fkey"
    )
    op.execute(
        f"ALTER TABLE {SCHEMA}.collections RENAME CONSTRAINT collections_pkey TO projects_pkey"
    )
    op.alter_column(
        "collections", "owner_user_id", new_column_name="creator_user_id", schema=SCHEMA
    )
    op.rename_table("collections", "projects", schema=SCHEMA)

    op.create_table(
        "task_projects",
        sa.Column(
            "task_id",
            sa.Uuid(),
            sa.ForeignKey(f"{SCHEMA}.tasks.id", ondelete="cascade"),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey(f"{SCHEMA}.projects.id", ondelete="cascade"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("task_id", "project_id"),
        schema=SCHEMA,
    )
    op.create_index("ix_task_projects_project", "task_projects", ["project_id"], schema=SCHEMA)
