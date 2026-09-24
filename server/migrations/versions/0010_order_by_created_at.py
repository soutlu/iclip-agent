"""列表改按建立时间倒序：索引跟着换列，不动表结构与数据。

Revision ID: 4b6f18c3ea70
Revises: 7c4a91e2b5d8
Create Date: 2026-09-17 10:00:00.000000

对话、合集、需求单的列表一律按 ``(created_at, id)`` 倒序，
原先按 ``updated_at`` 编的索引就没有读路径了。这里把它们换成建立时间的复合索引，索引里带上 ``id``
以同时支撑排序与游标。``ix_conversations_updated`` 保留：审计报表的 idle 指标仍按最近活动筛。
``ix_conversations_task`` 不动，升序索引反向扫即可服务倒序。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4b6f18c3ea70"
down_revision: str | None = "7c4a91e2b5d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"

_LIVE = "deleted_at IS NULL"
_COLLECTED = "collection_id IS NOT NULL AND deleted_at IS NULL"

# 每项是（索引名, 表, 列, 部分索引条件）。两组互为反向：升级建上面这组，回滚还原下面那组。
_BY_CREATED = (
    (
        "ix_conversations_owner_created",
        "conversations",
        ["owner_user_id", "created_at DESC", "id DESC"],
        _LIVE,
    ),
    ("ix_conversations_created", "conversations", ["created_at DESC", "id DESC"], None),
    (
        "ix_conversations_collection",
        "conversations",
        ["collection_id", "created_at DESC", "id DESC"],
        _COLLECTED,
    ),
    (
        "ix_collections_owner_created",
        "collections",
        ["owner_user_id", "created_at DESC", "id DESC"],
        None,
    ),
    ("ix_collections_created", "collections", ["created_at DESC", "id DESC"], None),
    ("ix_tasks_created", "tasks", ["created_at DESC", "id DESC"], None),
)

_BY_UPDATED = (
    ("ix_conversations_owner_recent", "conversations", ["owner_user_id", "updated_at DESC"], _LIVE),
    (
        "ix_conversations_collection",
        "conversations",
        ["collection_id", "updated_at DESC"],
        _COLLECTED,
    ),
    ("ix_collections_owner_recent", "collections", ["owner_user_id", "updated_at DESC"], None),
    ("ix_collections_updated", "collections", ["updated_at DESC"], None),
    ("ix_tasks_updated", "tasks", ["updated_at DESC"], None),
)

_Index = tuple[str, str, list[str], str | None]


def _drop(indexes: Sequence[_Index]) -> None:
    for name, table, _, _where in indexes:
        op.drop_index(name, table_name=table, schema=SCHEMA)


def _create(indexes: Sequence[_Index]) -> None:
    for name, table, columns, where in indexes:
        op.create_index(
            name,
            table,
            [sa.text(column) for column in columns],
            schema=SCHEMA,
            postgresql_where=sa.text(where) if where is not None else None,
        )


def upgrade() -> None:
    _drop(_BY_UPDATED)
    _create(_BY_CREATED)


def downgrade() -> None:
    _drop(_BY_CREATED)
    _create(_BY_UPDATED)
