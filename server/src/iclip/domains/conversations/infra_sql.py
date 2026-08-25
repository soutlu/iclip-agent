"""``iclip.conversations`` 的 Postgres 后端。DDL 归 Alembic，这里不建表。

所有时刻都取数据库的时钟（``now()``）。多台应用服务器的时钟差几秒，「最近活动」的
排序就会乱，而对话列表就是按它排的。
"""

from __future__ import annotations

import uuid
from typing import Final

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    MetaData,
    Table,
    Text,
    Uuid,
    delete,
    func,
    select,
    update,
)
from sqlalchemy.engine.row import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import NotFound
from iclip.domains.conversations.models import Conversation

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

conversations_table = Table(
    "conversations",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column(
        "owner_user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="cascade"),
        nullable=False,
    ),
    # agent 在配置文件里声明，库里没有对应的行，所以这里没有外键可挂。
    Column("agent_id", Text, nullable=False),
    Column("title", Text, nullable=False),
    Column("last_run_id", Text, nullable=True),
    # 这段对话是为哪张需求单开的。空着就是「直接开始创作」，不属于任何一张单。
    # set null 而不是 cascade：删掉一张单不该带走别人为它跑过的对话。
    Column(
        "task_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.tasks.id", ondelete="set null"),
        nullable=True,
    ),
    # 放在哪个项目里，最多一个，随时可以换。空着就是没归类。
    Column(
        "project_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.projects.id", ondelete="set null"),
        nullable=True,
    ),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

_ROWS = conversations_table.c

# 列表页就这一个查询：我的对话，最近活动的排前面。首列是属主，所以不用再单独给
# owner_user_id 建索引。
Index("ix_conversations_owner_recent", _ROWS.owner_user_id, _ROWS.updated_at.desc())

# 这两条都带 WHERE：没挂单、没进项目的对话是多数，不该占索引。
# 单那条按 created_at 升序——「这张单的第几次尝试」就是按它排出来的。
Index(
    "ix_conversations_task",
    _ROWS.task_id,
    _ROWS.created_at,
    postgresql_where=_ROWS.task_id.isnot(None),
)
Index(
    "ix_conversations_project",
    _ROWS.project_id,
    _ROWS.updated_at.desc(),
    postgresql_where=_ROWS.project_id.isnot(None),
)


def _row(mapping: RowMapping) -> Conversation:
    return Conversation(
        id=mapping["id"],
        owner_user_id=mapping["owner_user_id"],
        agent_id=mapping["agent_id"],
        title=mapping["title"],
        last_run_id=mapping["last_run_id"],
        created_at=mapping["created_at"],
        updated_at=mapping["updated_at"],
    )


class SqlConversationRepository:
    """``ConversationRepository`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def create(self, conversation: Conversation) -> Conversation:
        statement = (
            conversations_table.insert()
            .values(
                id=conversation.id,
                owner_user_id=conversation.owner_user_id,
                agent_id=conversation.agent_id,
                title=conversation.title,
                last_run_id=None,
                created_at=func.now(),
                updated_at=func.now(),
            )
            .returning(*conversations_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one()
        return _row(row)

    async def get(self, conversation_id: uuid.UUID, *, owner: uuid.UUID) -> Conversation:
        statement = select(conversations_table).where(
            _ROWS.id == conversation_id, _ROWS.owner_user_id == owner
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        if row is None:
            raise NotFound("没有这段对话")
        return _row(row)

    async def list_for_owner(self, *, owner: uuid.UUID, limit: int) -> tuple[Conversation, ...]:
        statement = (
            select(conversations_table)
            .where(_ROWS.owner_user_id == owner)
            .order_by(_ROWS.updated_at.desc())
            .limit(limit)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()
        return tuple(_row(row) for row in rows)

    async def rename(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, title: str
    ) -> Conversation:
        statement = (
            update(conversations_table)
            .where(_ROWS.id == conversation_id, _ROWS.owner_user_id == owner)
            .values(title=title, updated_at=func.now())
            .returning(*conversations_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        if row is None:
            raise NotFound("没有这段对话")
        return _row(row)

    async def delete(self, conversation_id: uuid.UUID, *, owner: uuid.UUID) -> None:
        statement = (
            delete(conversations_table)
            .where(_ROWS.id == conversation_id, _ROWS.owner_user_id == owner)
            .returning(_ROWS.id)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).first()
        if row is None:
            raise NotFound("没有这段对话")

    async def touch_run(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, agent_id: str, run_id: str
    ) -> None:
        # agent_id 进 WHERE 而不是 SET：对不上就一行也改不到，于是抛 NotFound。
        statement = (
            update(conversations_table)
            .where(
                _ROWS.id == conversation_id,
                _ROWS.owner_user_id == owner,
                _ROWS.agent_id == agent_id,
            )
            .values(last_run_id=run_id, updated_at=func.now())
            .returning(_ROWS.id)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).first()
        if row is None:
            raise NotFound("没有这段对话")


__all__ = [
    "DB_SCHEMA",
    "SqlConversationRepository",
    "conversations_table",
    "metadata_obj",
]
