"""用户发上来的消息，与「一段对话同时只跑一次」这条规矩。

一条 prompt 从收下到跑完要经过好几次进程往返（收下 → 排队 → 起 run → 跑完 → 排下一条），
而它在别处推不出来：排队中的那条只存在于这张表里，丢了就是用户打的字凭空消失。所以它落库，
不待在进程内存里。

**「同时只跑一条」由库上的部分唯一索引挡住**，不靠调用方先查后写：两个请求同时进来时，先查
后写的那种写法两边都会读到「没人在跑」。索引挡下来之后第二条改记成排队。

进程重启时表里会留下两种没人管的行：``running`` 的那条，它的 run 已经随进程没了；``queued``
的那些，没有任何东西会来叫醒它们。启动时一并收拾掉（见 ``discard_stale``）——留着不动的话，
那段对话会永远「正在跑」，之后发的每一条都排在一个不存在的运行后面。
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal, cast

from pydantic import TypeAdapter
from sqlalchemy import (
    Column,
    Index,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    case,
    exists,
    insert,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import TIMESTAMP, UUID
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import Conflict, NotFound
from iclip.platform.transcript.ops import Prompt, PromptContent

DB_SCHEMA: Final = "agent_runtime"

PromptStatus = Literal["running", "queued", "blocked", "completed", "failed", "aborted"]

_LIVE: Final = ("running", "queued")

metadata_obj = MetaData(schema=DB_SCHEMA)

prompts_table = Table(
    "prompts",
    metadata_obj,
    Column("prompt_id", Text, nullable=False),
    Column("conversation_id", Text, nullable=False),
    Column("agent_id", Text, nullable=False),
    Column("owner_user_id", UUID(as_uuid=True), nullable=False),
    Column("content", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("run_id", Text),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False),
    Column("finished_at", TIMESTAMP(timezone=True)),
    Column("steered_at", TIMESTAMP(timezone=True)),
    PrimaryKeyConstraint("prompt_id"),
    Index(
        "uq_prompts_one_running_per_conversation",
        "conversation_id",
        unique=True,
        postgresql_where=Column("status") == "running",
    ),
    Index("idx_prompts_queue", "conversation_id", "created_at"),
)


@dataclass(frozen=True, slots=True)
class PromptRow:
    """一条 prompt 的持久事实行。"""

    prompt_id: str
    conversation_id: str
    agent_id: str
    owner_user_id: uuid.UUID
    content: tuple[PromptContent, ...]
    status: PromptStatus
    run_id: str | None
    created_at: datetime
    finished_at: datetime | None
    steered_at: datetime | None

    @property
    def text(self) -> str:
        """这条 prompt 里用户打的字。多段文字之间用换行接起来。"""

        return "\n".join(part.text for part in self.content if part.type == "text")

    def as_entity(self) -> Prompt:
        """协议里的 ``prompt`` 实体。``prompt.upsert`` 与订阅快照发的就是这一份。"""

        return Prompt(
            prompt_id=self.prompt_id,
            status=self.status,
            content=self.content,
            created_at=self.created_at.isoformat(),
            finished_at=None if self.finished_at is None else self.finished_at.isoformat(),
            steered_at=None if self.steered_at is None else self.steered_at.isoformat(),
        )


@dataclass(frozen=True, slots=True)
class PromptQueueView:
    """一段对话此刻的排程：在跑的那条，加排着的那些。"""

    active: PromptRow | None
    queued: tuple[PromptRow, ...]


class PromptQueue:
    """按对话排 prompt。DDL 由 Alembic 迁移拥有，这里不自建表。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def submit(
        self,
        *,
        prompt_id: str,
        conversation_id: str,
        agent_id: str,
        owner_user_id: uuid.UUID,
        content: tuple[PromptContent, ...],
        now: datetime,
    ) -> PromptRow:
        """收下一条 prompt：这段对话空着就记成在跑，否则记成排队。

        状态由一条 ``INSERT ... SELECT`` 自己判，不先查后写——两条同时进来时先查后写会双双
        读到「空着」，然后一起去起 run。

        ``prompt_id`` 由调用方铸，重复提交同一个 id 返回已有那条（客户端重试不会多起一次
        运行，也不会多出一条排队）。
        """

        existing = await self.get(prompt_id)
        if existing is not None:
            return existing
        busy = exists(
            select(prompts_table.c.prompt_id)
            .where(prompts_table.c.conversation_id == conversation_id)
            .where(prompts_table.c.status == "running")
        )
        values = {
            "prompt_id": prompt_id,
            "conversation_id": conversation_id,
            "agent_id": agent_id,
            "owner_user_id": owner_user_id,
            "content": _dump(content),
            "created_at": now,
        }
        stmt = (
            insert(prompts_table)
            .values(**values, status=case((busy, "queued"), else_="running"))
            .returning(prompts_table)
        )
        try:
            async with self._engine.begin() as conn:
                row = (await conn.execute(stmt)).one()
        except IntegrityError:
            # 唯一索引拦下来了：另一条 prompt 在这几微秒里抢先占住了「在跑」那个位置。
            # 那条 CASE 判断和这次写入之间没有锁，所以这条路一定会有人走到。
            async with self._engine.begin() as conn:
                row = (
                    await conn.execute(
                        insert(prompts_table)
                        .values(**values, status="queued")
                        .returning(prompts_table)
                    )
                ).one()
        return _row(row)

    async def view(self, conversation_id: str) -> PromptQueueView:
        """这段对话此刻在跑的和排着的。跑完的不在里面。"""

        stmt = (
            select(prompts_table)
            .where(prompts_table.c.conversation_id == conversation_id)
            .where(prompts_table.c.status.in_(_LIVE))
            .order_by(prompts_table.c.created_at.asc(), prompts_table.c.prompt_id.asc())
        )
        async with self._engine.connect() as conn:
            rows = [_row(row) for row in (await conn.execute(stmt)).all()]
        active = next((row for row in rows if row.status == "running"), None)
        return PromptQueueView(
            active=active, queued=tuple(row for row in rows if row.status == "queued")
        )

    async def get(self, prompt_id: str) -> PromptRow | None:
        stmt = select(prompts_table).where(prompts_table.c.prompt_id == prompt_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        return None if row is None else _row(row)

    async def start_next(self, conversation_id: str) -> PromptRow | None:
        """把排在最前的那条转成在跑，返回它；没有排队的、或者还有在跑的，返回 ``None``。

        「还有在跑的就不动」写在 SQL 的条件里而不是调用方那边：run 结束和新 prompt 进来是两
        条各自独立的路，两边同时来叫它是正常的。
        """

        head = (
            select(prompts_table.c.prompt_id)
            .where(prompts_table.c.conversation_id == conversation_id)
            .where(prompts_table.c.status == "queued")
            .order_by(prompts_table.c.created_at.asc(), prompts_table.c.prompt_id.asc())
            .limit(1)
            .scalar_subquery()
        )
        running = (
            select(prompts_table.c.prompt_id)
            .where(prompts_table.c.conversation_id == conversation_id)
            .where(prompts_table.c.status == "running")
        )
        stmt = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id == head)
            .where(~exists(running))
            .values(status="running")
            .returning(prompts_table)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        return None if row is None else _row(row)

    async def attach_run(self, prompt_id: str, run_id: str) -> None:
        """记下这条 prompt 起的是哪次 run，好把它和 transcript 里那一轮对上。"""

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id == prompt_id)
            .values(run_id=run_id)
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)

    async def finish(self, prompt_id: str, *, status: PromptStatus, now: datetime) -> None:
        """给一条 prompt 收尾。已经收过尾的不再动——第一次的结局才是真的。"""

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id == prompt_id)
            .where(prompts_table.c.status.in_(_LIVE))
            .values(status=status, finished_at=now)
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)

    async def abort(self, prompt_id: str, *, now: datetime) -> PromptRow:
        """撤掉一条 prompt。

        排队中的直接标掉，这里就完事了。正在跑的只标一半——真正把运行停掉是运行侧的事，这里
        不知道那次 run 在谁手上，所以返回该行让调用方接着办。

        已经跑完的抛 ``Conflict``：重复点停止是常事，但不能假装刚刚停掉了什么。
        """

        row = await self.get(prompt_id)
        if row is None:
            raise NotFound(f"没有这条消息：{prompt_id}")
        if row.status not in _LIVE:
            raise Conflict("这条消息已经结束了，停不了")
        if row.status == "queued":
            await self.finish(prompt_id, status="aborted", now=now)
        return row

    async def steer(
        self, conversation_id: str, prompt_ids: tuple[str, ...], *, now: datetime
    ) -> tuple[PromptRow, ...]:
        """把排队中的几条插进正在跑的那一轮。

        这里只负责把它们从队列里摘下来并标上时刻；把内容送进运行是运行侧的事。有一条不是
        「这段对话里排着的」就整批不动——插一半进去、另一半留在队列里，用户看到的顺序就乱了。
        """

        view = await self.view(conversation_id)
        if view.active is None:
            raise Conflict("这段对话现在没有在跑的运行，插不进去")
        queued = {row.prompt_id: row for row in view.queued}
        picked = []
        for prompt_id in prompt_ids:
            row = queued.get(prompt_id)
            if row is None:
                raise NotFound(f"这条消息不在这段对话的队列里：{prompt_id}")
            picked.append(row)
        stmt = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id.in_(prompt_ids))
            .where(prompts_table.c.status == "queued")
            .values(status="completed", steered_at=now, finished_at=now)
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)
        return tuple(picked)

    async def discard_stale(self, *, now: datetime) -> int:
        """启动时收拾上一条命留下的行，返回收拾了几条。

        在跑的那条判成失败：它的运行随进程一起没了，谁也不会再来给它收尾。排队的那些判成撤销
        ——自动接着跑等于服务器重启后自己花钱去调模型，而且那一轮的上下文已经断了。用户看到的
        是一条「撤销了」的记录，可以重发；不是凭空消失。
        """

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.status.in_(_LIVE))
            .values(
                status=case((prompts_table.c.status == "running", "failed"), else_="aborted"),
                finished_at=now,
            )
        )
        async with self._engine.begin() as conn:
            return (await conn.execute(stmt)).rowcount


_CONTENT = TypeAdapter(tuple[PromptContent, ...])


def _dump(content: tuple[PromptContent, ...]) -> str:
    return json.dumps(
        [part.model_dump(by_alias=True, exclude_none=True) for part in content],
        ensure_ascii=False,
    )


class _PromptRow:
    """prompt 行的结构声明（仅供类型检查，运行时是 SQLAlchemy Row）。"""

    prompt_id: str
    conversation_id: str
    agent_id: str
    owner_user_id: uuid.UUID
    content: str
    status: str
    run_id: str | None
    created_at: datetime
    finished_at: datetime | None
    steered_at: datetime | None


def _row(row: object) -> PromptRow:
    r = cast("_PromptRow", row)
    return PromptRow(
        prompt_id=r.prompt_id,
        conversation_id=r.conversation_id,
        agent_id=r.agent_id,
        owner_user_id=r.owner_user_id,
        content=_CONTENT.validate_json(r.content),
        status=cast("PromptStatus", r.status),
        run_id=r.run_id,
        created_at=r.created_at,
        finished_at=r.finished_at,
        steered_at=r.steered_at,
    )


__all__ = [
    "DB_SCHEMA",
    "PromptQueue",
    "PromptQueueView",
    "PromptRow",
    "PromptStatus",
    "metadata_obj",
    "prompts_table",
]
