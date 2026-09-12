"""上传不登记：删 ``media_assets``；权限 ``assets:write`` → ``uploads:write``、``assets:read`` → ``inspirations:read``。

Revision ID: 9e3a7c5b2d41
Revises: 4c7d9e1f2a68
Create Date: 2026-09-12 15:00:00.000000

权限名同时存在两个 JSONB 数组里：``users.direct_permissions`` 与 ``api_keys.permissions``；
角色到权限的映射在代码里，不用迁。``media_assets`` 的存量行没有任何地方引用，随表删除，
downgrade 只能重建空表。决策见 docs/adr/0022-uploads-without-registry.md。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "9e3a7c5b2d41"
down_revision: str | None = "4c7d9e1f2a68"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"

RENAMES: tuple[tuple[str, str], ...] = (
    ("assets:write", "uploads:write"),
    ("assets:read", "inspirations:read"),
)

_PERMISSION_COLUMNS: tuple[tuple[str, str], ...] = (
    ("users", "direct_permissions"),
    ("api_keys", "permissions"),
)


def _rename_permissions(pairs: tuple[tuple[str, str], ...]) -> None:
    """把数组里的旧名换成新名；没有旧名的行不动。名字都是代码里的常量，不是外部输入。"""

    cases = " ".join(f"WHEN p = '{old}' THEN '{new}'" for old, new in pairs)
    olds = ", ".join(f"'{old}'" for old, _ in pairs)
    for table, column in _PERMISSION_COLUMNS:
        op.execute(
            f"""
            UPDATE {SCHEMA}.{table}
            SET {column} = (
                SELECT coalesce(jsonb_agg(DISTINCT CASE {cases} ELSE p END), '[]'::jsonb)
                FROM jsonb_array_elements_text({column}) AS p
            )
            WHERE {column} ?| array[{olds}]
            """
        )


def upgrade() -> None:
    _rename_permissions(RENAMES)
    op.drop_index("ix_media_assets_created", table_name="media_assets", schema=SCHEMA)
    op.drop_table("media_assets", schema=SCHEMA)


def downgrade() -> None:
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
    _rename_permissions(tuple((new, old) for old, new in RENAMES))
