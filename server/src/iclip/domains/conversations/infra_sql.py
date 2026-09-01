"""``iclip.conversations`` 的 Postgres 后端。DDL 归 Alembic，这里不建表。

所有时刻都取数据库的时钟（``now()``）。多台应用服务器的时钟差几秒，「最近活动」的
排序就会乱，而对话列表就是按它排的。
"""

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
    # agent 在配置文件里声明，库里没有对应的行，所以这里没有外键可挂。
    Column("agent_id", Text, nullable=False),
    Column("title", Text, nullable=False),
    # 这个标题是谁起的：default 还没起过、generated 小模型起的、custom 用户自己起的。
    # 自动生成只认 default 那一档，用户起过名的一律不覆盖。
    Column("title_kind", Text, nullable=False, server_default="default"),
    Column("last_run_id", Text, nullable=True),
    # 这段对话是为哪张需求单开的。空着就是「直接开始创作」，不属于任何一张单。
    # set null 而不是 cascade：删掉一张单不该带走别人为它跑过的对话。
    Column(
        "task_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.tasks.id", ondelete="set null"),
        nullable=True,
    ),
    # 放在哪个合集里，最多一个，随时可以换。空着就是没归类。
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

# 侧栏与搜索都走这一条：我的对话，最近活动的排前面。首列是属主，所以不用再单独给
# owner_user_id 建索引。
Index("ix_conversations_owner_recent", _ROWS.owner_user_id, _ROWS.updated_at.desc())

# 治理者的审计列表：跨属主按最近活动倒序翻页，带上 id 是因为翻页位置是这两列。
Index("ix_conversations_updated", _ROWS.updated_at.desc(), _ROWS.id.desc())

# 这两条都带 WHERE：没挂单、没进合集的对话是多数，不该占索引。
# 单那条按 created_at 升序——「这张单的第几次尝试」就是按它排出来的。
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
    """翻页条件：严格小于上一页最后一行的排序键。

    带上 id 一起比，同一时刻的几行才不会被跳过。侧栏往下滑与审计列表共用这一条。
    """

    if cursor is None:
        return []
    return [
        or_(
            _ROWS.updated_at < cursor.updated_at,
            and_(_ROWS.updated_at == cursor.updated_at, _ROWS.id < cursor.conversation_id),
        )
    ]


def _reject_missing_reference(error: IntegrityError) -> ValidationFailed:
    """外键挡下来的引用错误翻成领域错误。

    这一层不认识需求单表和合集表（架构上就不许认识），所以「那张单/那个合集在不在」
    只能由外键回答。区分是哪一个靠约束名——拿不到名字时就都报，比报错但说不清好。
    """

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
        self, *, owner: uuid.UUID, limit: int, after: PageCursor | None = None
    ) -> tuple[Conversation, ...]:
        return await self._page(
            _ROWS.owner_user_id == owner, _ROWS.collection_id.is_(None), limit=limit, after=after
        )

    async def count_ungrouped(self, *, owner: uuid.UUID) -> int:
        statement = (
            select(func.count())
            .select_from(conversations_table)
            .where(_ROWS.owner_user_id == owner, _ROWS.collection_id.is_(None))
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
    ) -> tuple[Conversation, ...]:
        return await self._page(
            _ROWS.owner_user_id == owner,
            _ROWS.collection_id == collection_id,
            limit=limit,
            after=after,
        )

    async def _page(
        self,
        *conditions: ColumnElement[bool],
        limit: int,
        after: PageCursor | None,
    ) -> tuple[Conversation, ...]:
        """按最近活动倒序取一页。侧栏两个区的翻页只差 WHERE 那一条。"""

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
        self, *, owner: uuid.UUID, collection_ids: tuple[uuid.UUID, ...], per_collection: int
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
        # 顺序按调用方给的合集顺序还原：库里那次排序是为了分组，不是给人看的。
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
        """改一处归属。两处归属的写法一模一样，差别只在改哪一列。"""

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
