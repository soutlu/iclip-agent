"""用户发上来的消息，与「一段对话同时只跑一次」这条规矩。

**「同时只跑一条」由库上的部分唯一索引挡住**，不靠调用方先查后写：两个请求同时进来时，先查
后写的那种写法两边都会读到「没人在跑」。索引挡下来之后第二条改记成排队。

这条挡板落在库上而不是进程内存里，因为它必须跨 worker：每个 worker 一份进程内存，谁也看不见谁
在跑。幂等键同理——重发可能打到另一个 worker。``content`` 列只服务同一条命里的接续。

**在跑的那条由租约认领**：``locked_by`` 记的是哪个进程在跑它，``heartbeat_at`` 由那个进程按周期
刷新，时间一律取数据库时钟。心跳停了超过一个租约、或者关停时被主动释放（``release``）的行，都算
中断：清扫把它重新认领下来续跑（``claim_interrupted``），``attempt`` 记它被重新认领过几次，到
``max_attempts`` 就判失败不再续跑（``fail_exhausted``）；排着的那些由清扫叫醒
（``conversations_waiting``）。``finish`` 与 ``attach_run`` 都带 ``locked_by`` 这道 fence——租约易手
之后它们一行都改不动，结局由接手的那一方定。

``steered`` 与 ``awaiting`` 都是**内部状态**，对外一律报 ``running``：协议的 prompt 状态联合里
没有这两个值，漏出去客户端整帧被 zod 拒掉且不报错。``steered`` 表示这条消息已经递进了某次 run
（``run_id`` 记的就是那次），结局跟着那一轮走；``awaiting`` 表示那次 run 停在审批上等人点头，
决定记在 ``decisions`` 里，凑齐一次响应里的全部审批才 CAS 回 ``running`` 起续跑。

**等审批的行照样占着这段对话**：它没有租约（心跳与清扫都不看它），但每处以 ``running`` 判「占着」
的地方都把它算进去，包括库上那道部分唯一索引。

**``prompts.run_id`` 只记最近一次，全部的记在 ``prompt_runs``。** 一条 prompt 可以由好几次 run
跑完（中断后续跑、审批后续跑），transcript 靠那张映射表把它们合成一轮。
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final, Literal, cast

from pydantic import TypeAdapter
from sqlalchemy import (
    Column,
    ColumnElement,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    and_,
    case,
    exists,
    func,
    insert,
    null,
    or_,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import TIMESTAMP, UUID
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import Conflict, NotFound
from iclip.platform.transcript.ops import Prompt, PromptContent

DB_SCHEMA: Final = "agent_runtime"

PromptStatus = Literal[
    "running", "awaiting", "queued", "steered", "blocked", "completed", "failed", "aborted"
]

_ACTIVE: Final = ("running", "awaiting")
"""占着这段对话的那两种。等审批的那一轮并没有结束，所以它也算占着。"""

_LIVE: Final = ("running", "awaiting", "queued")
"""还归队列管的那几种：占着的那条与排着的那些。``steered`` 已经交给运行侧了，不在里面。"""

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
    Column("locked_by", Text),
    Column("heartbeat_at", TIMESTAMP(timezone=True)),
    Column("interrupt_reason", Text),
    # 收下 prompt 的那条 INSERT 不写这一列，默认值由库给。
    Column("attempt", Integer, nullable=False, server_default="0"),
    Column("decisions", Text),
    PrimaryKeyConstraint("prompt_id"),
    Index(
        "uq_prompts_one_running_per_conversation",
        "conversation_id",
        unique=True,
        postgresql_where=Column("status").in_(_ACTIVE),
    ),
    Index("idx_prompts_queue", "conversation_id", "created_at"),
    Index(
        "idx_prompts_lease",
        "heartbeat_at",
        postgresql_where=Column("status") == "running",
    ),
)

prompt_runs_table = Table(
    "prompt_runs",
    metadata_obj,
    Column("run_id", Text, nullable=False),
    Column("prompt_id", Text, nullable=False),
    Column("started_at", TIMESTAMP(timezone=True), nullable=False),
    PrimaryKeyConstraint("run_id"),
    Index("idx_prompt_runs_prompt", "prompt_id"),
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
    locked_by: str | None
    heartbeat_at: datetime | None
    interrupt_reason: str | None
    attempt: int
    """中断后被重新认领过几次。第一次认领不算在里面。"""
    decisions: Mapping[str, bool]
    """人对这一轮的审批点了什么：工具调用 id → 是否放行。没等过审批就是空的。"""

    @property
    def text(self) -> str:
        """这条 prompt 里用户打的字。多段文字之间用换行接起来。"""

        return "\n".join(part.text for part in self.content if part.type == "text")

    def as_entity(self) -> Prompt:
        """协议里的 ``prompt`` 实体。``prompt.upsert`` 与订阅快照发的就是这一份。

        ``steered`` 与 ``awaiting`` 都报成 ``running``：两者都是这一轮的一部分，而协议的状态
        联合里没有这两个值。
        """

        return Prompt(
            prompt_id=self.prompt_id,
            status="running" if self.status in ("steered", "awaiting") else self.status,
            content=self.content,
            created_at=self.created_at.isoformat(),
            finished_at=None if self.finished_at is None else self.finished_at.isoformat(),
            steered_at=None if self.steered_at is None else self.steered_at.isoformat(),
        )


@dataclass(frozen=True, slots=True)
class PromptQueueView:
    """一段对话此刻的排程：占着的那条（在跑或者在等审批），加排着的那些。"""

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
        locked_by: str,
    ) -> PromptRow:
        """收下一条 prompt：这段对话空着就记成在跑，否则记成排队。

        状态由一条 ``INSERT ... SELECT`` 自己判，不先查后写——两条同时进来时先查后写会双双
        读到「空着」，然后一起去起 run。判成在跑的那一刻同时铸租约（``locked_by`` 记调用方这个
        进程，``heartbeat_at`` 取数据库时钟），排队的两列留空。

        ``prompt_id`` 由调用方铸，重复提交同一个 id 返回已有那条（客户端重试不会多起一次
        运行，也不会多出一条排队）。

        **认领只在同一段对话内算数。** id 是客户端铸的，两个人撞上同一个是完全可能的；不比
        对话就返回已有那条的话，撞上的人会拿到别人的消息记录，而他自己那条从来没被收下。
        """

        existing = await self.get(prompt_id)
        if existing is not None:
            if existing.conversation_id != conversation_id:
                raise Conflict("这个消息 id 已经用过了，换一个")
            return existing
        busy = exists(
            select(prompts_table.c.prompt_id)
            .where(prompts_table.c.conversation_id == conversation_id)
            .where(prompts_table.c.status.in_(_ACTIVE))
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
            .values(
                **values,
                status=case((busy, "queued"), else_="running"),
                locked_by=case((busy, null()), else_=locked_by),
                heartbeat_at=case((busy, null()), else_=func.now()),
            )
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
        """这段对话此刻占着的和排着的。跑完的不在里面。"""

        stmt = (
            select(prompts_table)
            .where(prompts_table.c.conversation_id == conversation_id)
            .where(prompts_table.c.status.in_(_LIVE))
            .order_by(prompts_table.c.created_at.asc(), prompts_table.c.prompt_id.asc())
        )
        async with self._engine.connect() as conn:
            rows = [_row(row) for row in (await conn.execute(stmt)).all()]
        active = next((row for row in rows if row.status in _ACTIVE), None)
        return PromptQueueView(
            active=active, queued=tuple(row for row in rows if row.status == "queued")
        )

    async def get(self, prompt_id: str) -> PromptRow | None:
        stmt = select(prompts_table).where(prompts_table.c.prompt_id == prompt_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        return None if row is None else _row(row)

    async def get_by_run(self, run_id: str) -> PromptRow | None:
        """发起那次 run 的那条 prompt；没记过就是 ``None``。

        按 ``prompt_runs`` 找，不按 ``prompts.run_id``：那一列记的是最近一次，而插话行也记着
        它被递进的那次 run（见 ``mark_steered``），照它查得挑一条。
        """

        stmt = (
            select(prompts_table)
            .join(prompt_runs_table, prompt_runs_table.c.prompt_id == prompts_table.c.prompt_id)
            .where(prompt_runs_table.c.run_id == run_id)
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        return None if row is None else _row(row)

    async def prompt_of_runs(self, conversation_id: str) -> dict[str, str]:
        """这段对话里每次 run 归哪条 prompt。transcript 靠它把多次 run 合成一轮。"""

        stmt = (
            select(prompt_runs_table.c.run_id, prompt_runs_table.c.prompt_id)
            .join(prompts_table, prompts_table.c.prompt_id == prompt_runs_table.c.prompt_id)
            .where(prompts_table.c.conversation_id == conversation_id)
        )
        async with self._engine.connect() as conn:
            return {run_id: prompt_id for run_id, prompt_id in (await conn.execute(stmt)).all()}

    async def prompt_status_of_runs(self, conversation_id: str) -> dict[str, str]:
        """这段对话里每次 run 归的那条 prompt 此刻是什么状态。

        transcript 的历史侧靠它给末尾那些开放的工具调用定性：等审批、撤销了还是失败了，消息本身
        说不出这件事。与 ``prompt_of_runs`` 分成两口，是因为轮号、截断、交接那几处调用方只要映射，
        返回一对值会让它们全都跟着解包。
        """

        stmt = (
            select(prompt_runs_table.c.run_id, prompts_table.c.status)
            .join(prompts_table, prompts_table.c.prompt_id == prompt_runs_table.c.prompt_id)
            .where(prompts_table.c.conversation_id == conversation_id)
        )
        async with self._engine.connect() as conn:
            return {run_id: status for run_id, status in (await conn.execute(stmt)).all()}

    async def active_statuses(self, conversation_ids: Sequence[str]) -> dict[str, PromptStatus]:
        """这几段对话里占着的那条 prompt 各是什么状态（``running`` / ``awaiting``）。

        空闲的那些不在返回里。侧栏的角标靠这一份跨进程对齐：实时状态是每 worker 一份的内存，
        重启之后是空的，而库里那条 prompt 还在跑、或者还等着人点头。
        """

        if not conversation_ids:
            return {}
        stmt = (
            select(prompts_table.c.conversation_id, prompts_table.c.status)
            .where(prompts_table.c.conversation_id.in_(tuple(conversation_ids)))
            .where(prompts_table.c.status.in_(_ACTIVE))
        )
        async with self._engine.connect() as conn:
            return {
                conversation_id: cast("PromptStatus", status)
                for conversation_id, status in (await conn.execute(stmt)).all()
            }

    async def start_next(self, conversation_id: str, *, locked_by: str) -> PromptRow | None:
        """把排在最前的那条转成在跑并铸上租约，返回它；没有排队的、或者还有占着的，返回 ``None``。

        「还有占着的就不动」写在 SQL 的条件里而不是调用方那边：run 结束和新 prompt 进来是两
        条各自独立的路，两边同时来叫它是正常的。多进程下两边同时叫会撞上那条部分唯一索引，撞
        了就是别人抢到了，返回 ``None``。
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
            .where(prompts_table.c.status.in_(_ACTIVE))
        )
        stmt = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id == head)
            .where(~exists(running))
            .values(status="running", locked_by=locked_by, heartbeat_at=func.now())
            .returning(prompts_table)
        )
        try:
            async with self._engine.begin() as conn:
                row = (await conn.execute(stmt)).one_or_none()
        except IntegrityError:
            return None
        return None if row is None else _row(row)

    async def attach_run(self, prompt_id: str, run_id: str, *, locked_by: str) -> None:
        """记下这条 prompt 起的是哪次 run，好把它和 transcript 里那一轮对上。

        租约不在自己手上就一行都不动：那一轮已经被别人判过结局了。

        两处写在同一个事务里：``prompts.run_id`` 记最近一次，``prompt_runs`` 记全部。只写成
        一半的话 transcript 会把同一条 prompt 的两次 run 画成两轮，而且不报错。
        """

        claim = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id == prompt_id)
            .where(prompts_table.c.locked_by == locked_by)
            .values(run_id=run_id)
        )
        async with self._engine.begin() as conn:
            if (await conn.execute(claim)).rowcount != 1:
                return
            await conn.execute(
                insert(prompt_runs_table).values(
                    run_id=run_id, prompt_id=prompt_id, started_at=func.now()
                )
            )

    async def finish(
        self, prompt_id: str, *, status: PromptStatus, now: datetime, locked_by: str
    ) -> None:
        """给自己手上那条 prompt 收尾。已经收过尾的、或者租约易手的都不再动。"""

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id == prompt_id)
            .where(prompts_table.c.status.in_(_LIVE))
            .where(prompts_table.c.locked_by == locked_by)
            .values(status=status, finished_at=now)
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)

    async def abort(self, prompt_id: str, *, now: datetime) -> PromptRow:
        """撤掉一条 prompt。

        排队中的与等审批的直接标掉；正在跑的只标一半——真正把运行停掉是运行侧的事，这里不知道
        那次 run 在谁手上。三种都返回该行：等审批的那一轮还占着实时状态，也要运行侧接着收拾。

        已经跑完的抛 ``Conflict``：重复点停止是常事，但不能假装刚刚停掉了什么。
        """

        row = await self.get(prompt_id)
        if row is None:
            raise NotFound(f"没有这条消息：{prompt_id}")
        if row.status == "steered":
            raise Conflict("这条消息已经递进当前这一轮了，要停就停整段对话")
        if row.status not in _LIVE:
            raise Conflict("这条消息已经结束了，停不了")
        if row.status in ("queued", "awaiting"):
            # 这两种行都没有租约，走不了 ``finish`` 那道 fence。
            stmt = (
                update(prompts_table)
                .where(prompts_table.c.prompt_id == prompt_id)
                .where(prompts_table.c.status == row.status)
                .values(status="aborted", finished_at=now)
            )
            async with self._engine.begin() as conn:
                await conn.execute(stmt)
        return row

    async def abort_queued(self, conversation_id: str, *, now: datetime) -> tuple[PromptRow, ...]:
        """把这段对话排着的全撤掉，返回撤掉的那几条。在跑的那条不动。

        一条 UPDATE 撤完，不逐条来：逐条之间的空档里，在跑的那条要是结束了，``start_next``
        就把还没撤到的队首顶上来接着跑。
        """

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.conversation_id == conversation_id)
            .where(prompts_table.c.status == "queued")
            .values(status="aborted", finished_at=now)
            .returning(prompts_table)
        )
        async with self._engine.begin() as conn:
            return tuple(_row(row) for row in (await conn.execute(stmt)).all())

    async def pick_for_steer(
        self, conversation_id: str, prompt_ids: tuple[str, ...]
    ) -> tuple[PromptRow, ...]:
        """挑出要插进当前这一轮的那几条，还不改状态。

        有一条不是「这段对话里排着的」就整批不动——插一半进去、另一半留在队列里，用户看到的
        顺序就乱了。
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
        return tuple(picked)

    async def mark_steered(
        self, prompt_ids: tuple[str, ...], *, run_id: str, now: datetime
    ) -> tuple[PromptRow, ...]:
        """记下这几条已经递进了哪次 run。结局不在这里定，跟着那一轮走。

        **先改状态再递内容**：反过来的话，递完到改完之间那一轮要是收场了，收场时的清扫看到的
        还是 ``queued``，什么都不会退回，随后这次写入把它钉成一个属于死运行的 ``steered``。
        """

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id.in_(prompt_ids))
            .where(prompts_table.c.status == "queued")
            .values(status="steered", run_id=run_id, steered_at=now)
            .returning(prompts_table)
        )
        async with self._engine.begin() as conn:
            return tuple(_row(row) for row in (await conn.execute(stmt)).all())

    async def settle_steered(
        self, run_id: str, *, status: PromptStatus, now: datetime
    ) -> tuple[PromptRow, ...]:
        """这次 run 收场了，递进去的那几条跟着它同一个结局。"""

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.run_id == run_id)
            .where(prompts_table.c.status == "steered")
            .values(status=status, finished_at=now)
            .returning(prompts_table)
        )
        async with self._engine.begin() as conn:
            return tuple(_row(row) for row in (await conn.execute(stmt)).all())

    async def requeue_steered(self, prompt_ids: tuple[str, ...]) -> tuple[PromptRow, ...]:
        """递进去了但那一轮没读到它，退回队列排着。

        一条追加要么进这次 run，要么退回 ``queued``；不留在一个已经收场的 run 名下。
        """

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id.in_(prompt_ids))
            .where(prompts_table.c.status == "steered")
            .values(status="queued", run_id=None, steered_at=None)
            .returning(prompts_table)
        )
        async with self._engine.begin() as conn:
            return tuple(_row(row) for row in (await conn.execute(stmt)).all())

    async def heartbeat(self, *, locked_by: str) -> tuple[str, ...]:
        """给这个进程手上还在跑的那些行刷一次心跳，返回刷到的 prompt id。

        调用方拿返回的这一组与自己内存里在跑的那些比对：不在里面的，租约已经不在自己手上。
        """

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.locked_by == locked_by)
            .where(prompts_table.c.status == "running")
            .values(heartbeat_at=func.now())
            .returning(prompts_table.c.prompt_id)
        )
        async with self._engine.begin() as conn:
            return tuple((await conn.execute(stmt)).scalars().all())

    async def release(self, prompt_id: str, *, locked_by: str, reason: str) -> None:
        """放掉自己手上那条的租约，行留在 ``running`` 等人接着跑。

        租约不在自己手上就一行都不动：那一轮已经归接手的那一方了。
        """

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id == prompt_id)
            .where(prompts_table.c.status == "running")
            .where(prompts_table.c.locked_by == locked_by)
            .values(locked_by=None, heartbeat_at=None, interrupt_reason=reason)
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)

    async def claim_interrupted(
        self, *, locked_by: str, lease_seconds: int, max_attempts: int
    ) -> tuple[PromptRow, ...]:
        """把中断的行认领下来续跑，返回认领到的那几条。

        第一次认领不计入 ``attempt``，所以拿 ``attempt + 1`` 与 ``max_attempts`` 比：配成 1 就是
        中断后只判失败、不续跑。

        **自己名下的行不认领。** 事件循环卡过一个租约（长 GC、同步活儿）时，自己在跑的那行也是
        「心跳落后」的样子；认领它等于同一段对话在同一个进程里起第二次运行，而先起的那一次心跳
        照样刷得到，谁也不会停下来。``IS DISTINCT FROM`` 是 NULL 安全的，关停释放过的行（
        ``locked_by`` 为空）照样认得到。
        """

        stmt = (
            update(prompts_table)
            .where(_interrupted(lease_seconds))
            .where(prompts_table.c.locked_by.is_distinct_from(locked_by))
            .where(prompts_table.c.attempt + 1 < max_attempts)
            .values(
                locked_by=locked_by,
                heartbeat_at=func.now(),
                attempt=prompts_table.c.attempt + 1,
            )
            .returning(prompts_table)
        )
        async with self._engine.begin() as conn:
            return tuple(_row(row) for row in (await conn.execute(stmt)).all())

    async def fail_exhausted(
        self, *, lease_seconds: int, max_attempts: int
    ) -> tuple[PromptRow, ...]:
        """认领次数已经用完的中断行判失败并放掉租约，返回它们。"""

        stmt = (
            update(prompts_table)
            .where(_interrupted(lease_seconds))
            .where(prompts_table.c.attempt + 1 >= max_attempts)
            .values(
                status="failed",
                finished_at=func.now(),
                locked_by=None,
                interrupt_reason=f"中断 {max_attempts} 次后放弃续跑",
            )
            .returning(prompts_table)
        )
        async with self._engine.begin() as conn:
            return tuple(_row(row) for row in (await conn.execute(stmt)).all())

    async def adopt_steered(self, old_run_id: str, new_run_id: str) -> None:
        """递进老 run 的那几条插话改挂续跑这次 run。

        不改挂的话它们等的是一个已经死掉的 run 定结局，永远停在「正在跑」。
        """

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.status == "steered")
            .where(prompts_table.c.run_id == old_run_id)
            .values(run_id=new_run_id)
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)

    async def await_approvals(self, prompt_id: str, *, locked_by: str) -> PromptRow | None:
        """这次 run 停在审批上了：行改成 ``awaiting`` 并放掉租约，``run_id`` 留着。

        租约不在自己手上就一行都不动，同 ``finish`` 那道 fence。放掉租约是因为没有 run 在跑了，
        没人刷心跳——留着的话清扫会把它当成中断的行认领去续跑。
        """

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id == prompt_id)
            .where(prompts_table.c.status == "running")
            .where(prompts_table.c.locked_by == locked_by)
            .values(status="awaiting", locked_by=None, heartbeat_at=None)
            .returning(prompts_table)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        return None if row is None else _row(row)

    async def record_decision(
        self, prompt_id: str, tool_call_id: str, *, approved: bool
    ) -> PromptRow:
        """记下人对一张审批卡点了什么，返回记完之后的那一行。

        同一张卡重复点同一个决定原样返回（客户端重试是常事），点相反的抛 ``Conflict``：工具那一侧
        可能已经照第一次的决定走下去了，悄悄换掉等于让界面和事实分家。

        读改写在同一个事务里加锁：两次点击落在两个连接上时，后写的那一次会把前一次的决定覆盖掉，
        于是凑齐审批的判断永远差一个。
        """

        async with self._engine.begin() as conn:
            current = (
                await conn.execute(
                    select(prompts_table)
                    .where(prompts_table.c.prompt_id == prompt_id)
                    .where(prompts_table.c.status == "awaiting")
                    .with_for_update()
                )
            ).one_or_none()
            if current is None:
                raise NotFound(f"这条消息没在等审批：{prompt_id}")
            decisions = dict(_row(current).decisions)
            settled = decisions.get(tool_call_id)
            if settled is not None:
                if settled != approved:
                    raise Conflict("这张审批卡已经回过了，改不了")
                return _row(current)
            decisions[tool_call_id] = approved
            updated = (
                await conn.execute(
                    update(prompts_table)
                    .where(prompts_table.c.prompt_id == prompt_id)
                    .values(decisions=json.dumps(decisions, ensure_ascii=False))
                    .returning(prompts_table)
                )
            ).one()
        return _row(updated)

    async def claim_for_continuation(self, prompt_id: str, *, locked_by: str) -> PromptRow | None:
        """审批凑齐了：CAS 回 ``running`` 并铸上租约，返回它；抢不到就是别人起了续跑，返回 ``None``。

        ``attempt`` 不加——那一列记的是「中断后重新认领过几次」，等人点头不是中断。``decisions``
        留着：续跑那次 run 要按它给官方 ``deferred_tool_results``。
        """

        stmt = (
            update(prompts_table)
            .where(prompts_table.c.prompt_id == prompt_id)
            .where(prompts_table.c.status == "awaiting")
            .values(status="running", locked_by=locked_by, heartbeat_at=func.now())
            .returning(prompts_table)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        return None if row is None else _row(row)

    async def conversations_waiting(self) -> tuple[str, ...]:
        """有排队的行、却一条占着的都没有的那些对话。它们等着人来叫。"""

        queued = prompts_table.alias("queued")
        running = (
            select(prompts_table.c.prompt_id)
            .where(prompts_table.c.conversation_id == queued.c.conversation_id)
            .where(prompts_table.c.status.in_(_ACTIVE))
        )
        stmt = (
            select(queued.c.conversation_id)
            .where(queued.c.status == "queued")
            .where(~exists(running))
            .distinct()
        )
        async with self._engine.connect() as conn:
            return tuple((await conn.execute(stmt)).scalars().all())


def _interrupted(lease_seconds: int) -> ColumnElement[bool]:
    """中断的判据：还记着在跑，但租约要么被主动放掉了、要么停了心跳。

    ``release`` 过的行 ``heartbeat_at`` 是 NULL，比不出「落后一个租约」，所以两种情形都要写上。
    认领与判失败共用这一份，各写一遍迟早会漂成两套判据、行卡在中间没人管。

    只看 ``running``：等审批的行没有租约也不刷心跳，它不是中断，是在等人。
    """

    return and_(
        prompts_table.c.status == "running",
        or_(
            prompts_table.c.locked_by.is_(None),
            prompts_table.c.heartbeat_at < func.now() - timedelta(seconds=lease_seconds),
        ),
    )


_CONTENT = TypeAdapter(tuple[PromptContent, ...])
_DECISIONS = TypeAdapter(dict[str, bool])


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
    locked_by: str | None
    heartbeat_at: datetime | None
    interrupt_reason: str | None
    attempt: int
    decisions: str | None


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
        locked_by=r.locked_by,
        heartbeat_at=r.heartbeat_at,
        interrupt_reason=r.interrupt_reason,
        attempt=r.attempt,
        decisions={} if r.decisions is None else _DECISIONS.validate_json(r.decisions),
    )


__all__ = [
    "DB_SCHEMA",
    "PromptQueue",
    "PromptQueueView",
    "PromptRow",
    "PromptStatus",
    "metadata_obj",
    "prompt_runs_table",
    "prompts_table",
]
