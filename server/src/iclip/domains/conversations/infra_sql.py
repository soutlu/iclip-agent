"""对话的 Postgres 仓储。使用数据库时钟，避免实例钟差影响最近活动排序。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Final

from sqlalchemy import (
    Column,
    ColumnElement,
    DateTime,
    ForeignKey,
    Index,
    MetaData,
    Table,
    Text,
    Uuid,
    and_,
    delete,
    func,
    or_,
    select,
    update,
)
from sqlalchemy.engine.row import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.conversations.models import Conversation
from iclip.domains.conversations.repository import CollectionConversations, PageCursor

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
    Column("agent_id", Text, nullable=False),
    Column("title", Text, nullable=False),
    Column("title_kind", Text, nullable=False, server_default="default"),
    Column("last_run_id", Text, nullable=True),
    # 删除需求单只清空归属，保留对话。
    Column(
        "task_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.tasks.id", ondelete="set null"),
        nullable=True,
    ),
    Column(
        "collection_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.collections.id", ondelete="set null"),
        nullable=True,
    ),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

_ROWS = conversations_table.c

# 首列覆盖 owner_user_id 查询，无需另建单列索引。
Index("ix_conversations_owner_recent", _ROWS.owner_user_id, _ROWS.updated_at.desc())

# 审计分页使用 updated_at 与 id 的复合游标。
Index("ix_conversations_updated", _ROWS.updated_at.desc(), _ROWS.id.desc())

# 部分索引排除无归属记录；需求单尝试按 created_at 升序排列。
Index(
    "ix_conversations_task",
    _ROWS.task_id,
    _ROWS.created_at,
    postgresql_where=_ROWS.task_id.isnot(None),
)
Index(
    "ix_conversations_collection",
    _ROWS.collection_id,
    _ROWS.updated_at.desc(),
    postgresql_where=_ROWS.collection_id.isnot(None),
)


def _row(mapping: RowMapping) -> Conversation:
    return Conversation(
        id=mapping["id"],
        owner_user_id=mapping["owner_user_id"],
        agent_id=mapping["agent_id"],
        title=mapping["title"],
        title_kind=mapping["title_kind"],
        last_run_id=mapping["last_run_id"],
        task_id=mapping["task_id"],
        collection_id=mapping["collection_id"],
        created_at=mapping["created_at"],
        updated_at=mapping["updated_at"],
    )


def _after(cursor: PageCursor | None) -> list[ColumnElement[bool]]:
    """按时间和 id 的复合排序键续页，避免跳过时间相同的记录。"""

    if cursor is None:
        return []
    return [
        or_(
            _ROWS.updated_at < cursor.updated_at,
            and_(_ROWS.updated_at == cursor.updated_at, _ROWS.id < cursor.conversation_id),
        )
    ]


def _only(only_ids: frozenset[uuid.UUID] | None) -> list[ColumnElement[bool]]:
    """None 不限制 id；其余集合用于活动状态筛选。"""

    return [] if only_ids is None else [_ROWS.id.in_(only_ids)]


def _reject_missing_reference(error: IntegrityError) -> ValidationFailed:
    """按外键约束名将无效归属转换为领域错误；无法取得约束名时报告两个可能的引用。"""

    constraint = getattr(getattr(error, "orig", None), "diag", None)
    name = getattr(constraint, "constraint_name", None) or ""
    if "task" in name:
        return ValidationFailed("没有这张需求单")
    if "collection" in name:
        return ValidationFailed("没有这个合集")
    return ValidationFailed("指定的需求单或合集不存在")


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
                title_kind=conversation.title_kind,
                last_run_id=None,
                task_id=conversation.task_id,
                collection_id=conversation.collection_id,
                created_at=func.now(),
                updated_at=func.now(),
            )
            .returning(*conversations_table.c)
        )
        try:
            async with self._engine.begin() as conn:
                row = (await conn.execute(statement)).mappings().one()
        except IntegrityError as exc:
            raise _reject_missing_reference(exc) from exc
        return _row(row)

    async def get(self, conversation_id: uuid.UUID, *, owner: uuid.UUID | None) -> Conversation:
        scope = [] if owner is None else [_ROWS.owner_user_id == owner]
        statement = select(conversations_table).where(_ROWS.id == conversation_id, *scope)
        async with self._engine.connect() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        if row is None:
            raise NotFound("没有这段对话")
        return _row(row)

    async def list_for_owner(
        self, *, owner: uuid.UUID, limit: int, title_contains: str | None = None
    ) -> tuple[Conversation, ...]:
        conditions = [_ROWS.owner_user_id == owner]
        if title_contains is not None:
            # autoescape：标题里出现 % 或 _ 时当普通字符，不当通配符
            conditions.append(_ROWS.title.icontains(title_contains, autoescape=True))
        statement = (
            select(conversations_table)
            .where(*conditions)
            .order_by(_ROWS.updated_at.desc())
            .limit(limit)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()
        return tuple(_row(row) for row in rows)

    async def list_ungrouped(
        self,
        *,
        owner: uuid.UUID,
        limit: int,
        after: PageCursor | None = None,
        only_ids: frozenset[uuid.UUID] | None = None,
    ) -> tuple[Conversation, ...]:
        return await self._page(
            _ROWS.owner_user_id == owner,
            _ROWS.collection_id.is_(None),
            *_only(only_ids),
            limit=limit,
            after=after,
        )

    async def count_ungrouped(
        self, *, owner: uuid.UUID, only_ids: frozenset[uuid.UUID] | None = None
    ) -> int:
        statement = (
            select(func.count())
            .select_from(conversations_table)
            .where(_ROWS.owner_user_id == owner, _ROWS.collection_id.is_(None), *_only(only_ids))
        )
        async with self._engine.connect() as conn:
            return int((await conn.execute(statement)).scalar_one())

    async def list_in_collection(
        self,
        *,
        owner: uuid.UUID,
        collection_id: uuid.UUID,
        limit: int,
        after: PageCursor | None = None,
        only_ids: frozenset[uuid.UUID] | None = None,
    ) -> tuple[Conversation, ...]:
        return await self._page(
            _ROWS.owner_user_id == owner,
            _ROWS.collection_id == collection_id,
            *_only(only_ids),
            limit=limit,
            after=after,
        )

    async def _page(
        self,
        *conditions: ColumnElement[bool],
        limit: int,
        after: PageCursor | None,
    ) -> tuple[Conversation, ...]:
        """按最近活动倒序分页，共用于侧栏未分类区和合集区。"""

        statement = (
            select(conversations_table)
            .where(*conditions, *_after(after))
            .order_by(_ROWS.updated_at.desc(), _ROWS.id.desc())
            .limit(limit)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()
        return tuple(_row(row) for row in rows)

    async def list_by_collections(
        self,
        *,
        owner: uuid.UUID,
        collection_ids: tuple[uuid.UUID, ...],
        per_collection: int,
        only_ids: frozenset[uuid.UUID] | None = None,
    ) -> tuple[CollectionConversations, ...]:
        if not collection_ids:
            return ()
        total = func.count().over(partition_by=_ROWS.collection_id).label("total")
        rank = (
            func.row_number()
            .over(partition_by=_ROWS.collection_id, order_by=_ROWS.updated_at.desc())
            .label("rank")
        )
        ranked = (
            select(conversations_table, total, rank)
            .where(
                _ROWS.owner_user_id == owner,
                _ROWS.collection_id.in_(collection_ids),
                # 窗口计数前完成筛选，保证总数与返回记录使用相同范围。
                *_only(only_ids),
            )
            .subquery()
        )
        statement = (
            select(ranked)
            .where(ranked.c.rank <= per_collection)
            .order_by(ranked.c.collection_id, ranked.c.rank)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()

        grouped: dict[uuid.UUID, list[RowMapping]] = {}
        for row in rows:
            grouped.setdefault(row["collection_id"], []).append(row)
        # 恢复调用方的合集顺序，SQL 内部排序仅用于分组。
        return tuple(
            CollectionConversations(
                collection_id=collection_id,
                total=int(grouped[collection_id][0]["total"]),
                conversations=tuple(_row(row) for row in grouped[collection_id]),
            )
            for collection_id in collection_ids
            if collection_id in grouped
        )

    async def list_for_task(
        self, *, task_id: uuid.UUID, owner: uuid.UUID
    ) -> tuple[Conversation, ...]:
        statement = (
            select(conversations_table)
            .where(_ROWS.task_id == task_id, _ROWS.owner_user_id == owner)
            .order_by(_ROWS.created_at)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()
        return tuple(_row(row) for row in rows)

    async def list_audit(
        self,
        *,
        owner: uuid.UUID | None = None,
        task_id: uuid.UUID | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: int,
        after: PageCursor | None = None,
    ) -> tuple[Conversation, ...]:
        conditions: list[ColumnElement[bool]] = []
        if owner is not None:
            conditions.append(_ROWS.owner_user_id == owner)
        if task_id is not None:
            conditions.append(_ROWS.task_id == task_id)
        if since is not None:
            conditions.append(_ROWS.updated_at >= since)
        if until is not None:
            conditions.append(_ROWS.updated_at <= until)
        conditions.extend(_after(after))
        statement = (
            select(conversations_table)
            .where(*conditions)
            .order_by(_ROWS.updated_at.desc(), _ROWS.id.desc())
            .limit(limit)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()
        return tuple(_row(row) for row in rows)

    async def set_collection(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, collection_id: uuid.UUID | None
    ) -> Conversation:
        return await self._set_membership(
            conversation_id, owner=owner, values={"collection_id": collection_id}
        )

    async def set_task(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, task_id: uuid.UUID | None
    ) -> Conversation:
        return await self._set_membership(conversation_id, owner=owner, values={"task_id": task_id})

    async def _set_membership(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, values: dict[str, uuid.UUID | None]
    ) -> Conversation:

        statement = (
            update(conversations_table)
            .where(_ROWS.id == conversation_id, _ROWS.owner_user_id == owner)
            .values(**values, updated_at=func.now())
            .returning(*conversations_table.c)
        )
        try:
            async with self._engine.begin() as conn:
                row = (await conn.execute(statement)).mappings().one_or_none()
        except IntegrityError as exc:
            raise _reject_missing_reference(exc) from exc
        if row is None:
            raise NotFound("没有这段对话")
        return _row(row)

    async def apply_generated_title(self, conversation_id: uuid.UUID, *, title: str) -> bool:
        statement = (
            update(conversations_table)
            .where(_ROWS.id == conversation_id, _ROWS.title_kind == "default")
            .values(title=title, title_kind="generated")
            .returning(_ROWS.id)
        )
        async with self._engine.begin() as conn:
            written = (await conn.execute(statement)).one_or_none()
        return written is not None

    async def rename(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, title: str
    ) -> Conversation:
        statement = (
            update(conversations_table)
            .where(_ROWS.id == conversation_id, _ROWS.owner_user_id == owner)
            .values(title=title, title_kind="custom", updated_at=func.now())
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
        # agent_id 仅用于匹配，不能改写对话绑定。
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
