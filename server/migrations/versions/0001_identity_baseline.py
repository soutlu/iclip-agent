"""identity baseline

Revision ID: eca15db4a439
Revises:
Create Date: 2026-08-19 00:08:29.724599
"""

from __future__ import annotations

from collections.abc import Sequence

import fastapi_users_db_sqlalchemy.generics
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "eca15db4a439"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("username", sa.String(length=150), nullable=True),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("avatar_url", sa.String(length=1024), nullable=False),
        sa.Column("roles", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("direct_permissions", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("city", sa.String(length=255), nullable=False),
        sa.Column("job_title", sa.String(length=255), nullable=False),
        sa.Column("departments", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", fastapi_users_db_sqlalchemy.generics.GUID(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("hashed_password", sa.String(length=1024), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("is_superuser", sa.Boolean(), nullable=False),
        sa.Column("is_verified", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("username"),
        schema="iclip",
    )
    op.create_index(op.f("ix_iclip_users_email"), "users", ["email"], unique=True, schema="iclip")
    op.create_table(
        "api_keys",
        sa.Column("id", fastapi_users_db_sqlalchemy.generics.GUID(), nullable=False),
        sa.Column("owner_user_id", fastapi_users_db_sqlalchemy.generics.GUID(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("token_prefix", sa.String(length=24), nullable=False),
        sa.Column("permissions", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["iclip.users.id"], ondelete="cascade"),
        sa.PrimaryKeyConstraint("id"),
        schema="iclip",
    )
    op.create_index(
        op.f("ix_iclip_api_keys_owner_user_id"),
        "api_keys",
        ["owner_user_id"],
        unique=False,
        schema="iclip",
    )
    op.create_index(
        op.f("ix_iclip_api_keys_token_hash"),
        "api_keys",
        ["token_hash"],
        unique=True,
        schema="iclip",
    )
    op.create_table(
        "oauth_accounts",
        sa.Column("user_id", fastapi_users_db_sqlalchemy.generics.GUID(), nullable=False),
        sa.Column("id", fastapi_users_db_sqlalchemy.generics.GUID(), nullable=False),
        sa.Column("oauth_name", sa.String(length=100), nullable=False),
        sa.Column("access_token", sa.String(length=1024), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=True),
        sa.Column("refresh_token", sa.String(length=1024), nullable=True),
        sa.Column("account_id", sa.String(length=320), nullable=False),
        sa.Column("account_email", sa.String(length=320), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["iclip.users.id"], ondelete="cascade"),
        sa.PrimaryKeyConstraint("id"),
        schema="iclip",
    )
    op.create_index(
        op.f("ix_iclip_oauth_accounts_account_id"),
        "oauth_accounts",
        ["account_id"],
        unique=False,
        schema="iclip",
    )
    op.create_index(
        op.f("ix_iclip_oauth_accounts_oauth_name"),
        "oauth_accounts",
        ["oauth_name"],
        unique=False,
        schema="iclip",
    )
    op.create_index(
        op.f("ix_iclip_oauth_accounts_user_id"),
        "oauth_accounts",
        ["user_id"],
        unique=False,
        schema="iclip",
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_iclip_oauth_accounts_user_id"), table_name="oauth_accounts", schema="iclip"
    )
    op.drop_index(
        op.f("ix_iclip_oauth_accounts_oauth_name"), table_name="oauth_accounts", schema="iclip"
    )
    op.drop_index(
        op.f("ix_iclip_oauth_accounts_account_id"), table_name="oauth_accounts", schema="iclip"
    )
    op.drop_table("oauth_accounts", schema="iclip")
    op.drop_index(op.f("ix_iclip_api_keys_token_hash"), table_name="api_keys", schema="iclip")
    op.drop_index(op.f("ix_iclip_api_keys_owner_user_id"), table_name="api_keys", schema="iclip")
    op.drop_table("api_keys", schema="iclip")
    op.drop_index(op.f("ix_iclip_users_email"), table_name="users", schema="iclip")
    op.drop_table("users", schema="iclip")
