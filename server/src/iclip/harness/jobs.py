"""持久化消息队列、运行租约与审批状态。

部分唯一索引保证每段对话最多一条 running/awaiting 消息，跨 worker 共享幂等与排队状态。
租约使用数据库时钟，写入以持有者和 attempt 校验，防止旧运行覆盖续跑结果。
steered/awaiting 对外映射为 running；awaiting 占用会话但不持有租约。
agent_jobs.run_id 记录最近运行，agent_job_runs 保存全部映射，供 transcript 合并轮次。
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final, Literal, cast

from pydantic import TypeAdapter
from sqlalchemy import (
    Column,
    ColumnElement,
    Executable,
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
from iclip.harness.transcript.activity import ActivityState, activity_of
from iclip.platform.transcript.ops import Prompt, PromptContent

DB_SCHEMA: Final = "agent_runtime"

JobStatus = Literal["running", "awaiting", "queued", "steered", "completed", "failed", "aborted"]

_ACTIVE: Final = ("running", "awaiting")
"""占用会话的状态，包含等待审批的运行。"""

_LIVE: Final = ("running", "awaiting", "queued")
"""队列管理的状态；steered 已交由运行侧管理。"""

metadata_obj = MetaData(schema=DB_SCHEMA)

agent_jobs_table = Table(
    "agent_jobs",
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
    # INSERT 省略此列，使用数据库默认值。
    Column("attempt", Integer, nullable=False, server_default="0"),
    Column("decisions", Text),
    PrimaryKeyConstraint("prompt_id"),
    Index(
        "uq_agent_jobs_one_running_per_conversation",
        "conversation_id",
        unique=True,
        postgresql_where=Column("status").in_(_ACTIVE),
    ),
    Index("idx_agent_jobs_queue", "conversation_id", "created_at"),
    Index(
        "idx_agent_jobs_lease",
        "heartbeat_at",
        postgresql_where=Column("status") == "running",
    ),
)

agent_job_runs_table = Table(
    "agent_job_runs",
    metadata_obj,
    Column("run_id", Text, nullable=False),
    Column("prompt_id", Text, nullable=False),
    Column("started_at", TIMESTAMP(timezone=True), nullable=False),
    PrimaryKeyConstraint("run_id"),
    Index("idx_agent_job_runs_prompt", "prompt_id"),
)


@dataclass(frozen=True, slots=True)
class JobRow:
    """持久化消息记录。"""

    prompt_id: str
    conversation_id: str
    agent_id: str
    owner_user_id: uuid.UUID
    content: tuple[PromptContent, ...]
    status: JobStatus
    run_id: str | None
    created_at: datetime
    finished_at: datetime | None
    steered_at: datetime | None
    locked_by: str | None
    heartbeat_at: datetime | None
    interrupt_reason: str | None
    attempt: int
    """中断后的重新认领次数，不含首次认领。"""
    decisions: Mapping[str, bool]
    """工具调用 id 到审批决定的映射。"""

    @property
    def text(self) -> str:
        """以换行连接消息中的文本部分。"""

        return "\n".join(part.text for part in self.content if part.type == "text")

    def as_entity(self) -> Prompt:
        """生成协议 prompt；内部 steered/awaiting 状态映射为 running。"""

        return Prompt(
            prompt_id=self.prompt_id,
            status="running" if self.status in ("steered", "awaiting") else self.status,
            content=self.content,
            created_at=self.created_at.isoformat(),
            finished_at=None if self.finished_at is None else self.finished_at.isoformat(),
            steered_at=None if self.steered_at is None else self.steered_at.isoformat(),
        )


@dataclass(frozen=True, slots=True)
class JobQueueView:
    """会话中占用执行位置与排队中的消息。"""

    active: JobRow | None
    queued: tuple[JobRow, ...]


ActivityChanged = Callable[[str, uuid.UUID, ActivityState], None]
"""会话活动变更回调，参数为 (对话 id, 属主, 活动)。

提交后同步发送，确保 idle 先于后续 busy。属主直接取自消息行，避免 await 查询打乱发送顺序。
"""


class JobQueue:
    """按会话调度消息；DDL 由 Alembic 管理。"""

    def __init__(self, engine: AsyncEngine, *, on_activity: ActivityChanged | None = None) -> None:
        self._engine = engine
        self._on_activity = on_activity

    def _changed(self, row: JobRow, status: JobStatus) -> None:
        """事务提交后广播活动变更，避免发送回滚状态；连续运行依次发出 idle、busy。"""

        if self._on_activity is not None:
            self._on_activity(row.conversation_id, row.owner_user_id, activity_of(status))

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
    ) -> JobRow:
        """提交消息并原子决定运行或排队。

        运行行同时创建租约，时间取数据库时钟；占用唯一索引冲突时改为排队。
        prompt_id 重复时返回同会话中的已有记录；跨会话复用 id 必须拒绝，防止泄露消息。
        """

        existing = await self.get(prompt_id)
        if existing is not None:
            if existing.conversation_id != conversation_id:
                raise Conflict("这个消息 id 已经用过了，换一个")
            return existing
        busy = exists(
            select(agent_jobs_table.c.prompt_id)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status.in_(_ACTIVE))
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
            insert(agent_jobs_table)
            .values(
                **values,
                status=case((busy, "queued"), else_="running"),
                locked_by=case((busy, null()), else_=locked_by),
                heartbeat_at=case((busy, null()), else_=func.now()),
            )
            .returning(agent_jobs_table)
        )
        try:
            row = await self._one(stmt)
        except IntegrityError:
            # INSERT 判定后仍可能并发占用执行位置，由部分唯一索引裁决。
            try:
                row = await self._one(
                    insert(agent_jobs_table)
                    .values(**values, status="queued")
                    .returning(agent_jobs_table)
                )
            except IntegrityError:
                # 同一 prompt_id 并发提交，读取已成功写入的记录。
                existing = await self.get(prompt_id)
                if existing is None:
                    raise
                return existing
        if row is None:
            raise Conflict("这条消息没被收下")
        if row.status == "running":
            self._changed(row, row.status)
        return row

    async def view(self, conversation_id: str) -> JobQueueView:
        """返回会话中占用执行位置和排队中的消息。"""

        stmt = (
            select(agent_jobs_table)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status.in_(_LIVE))
            .order_by(agent_jobs_table.c.created_at.asc(), agent_jobs_table.c.prompt_id.asc())
        )
        rows = await self._rows(stmt)
        active = next((row for row in rows if row.status in _ACTIVE), None)
        return JobQueueView(
            active=active, queued=tuple(row for row in rows if row.status == "queued")
        )

    async def get(self, prompt_id: str) -> JobRow | None:
        found = await self._rows(
            select(agent_jobs_table).where(agent_jobs_table.c.prompt_id == prompt_id)
        )
        return found[0] if found else None

    async def get_by_run(self, run_id: str) -> JobRow | None:
        """通过 agent_job_runs 查询发起运行的消息；agent_jobs.run_id 仅表示最近运行且包含插话。"""

        stmt = (
            select(agent_jobs_table)
            .join(
                agent_job_runs_table,
                agent_job_runs_table.c.prompt_id == agent_jobs_table.c.prompt_id,
            )
            .where(agent_job_runs_table.c.run_id == run_id)
        )
        found = await self._rows(stmt)
        return found[0] if found else None

    async def prompt_of_runs(self, conversation_id: str) -> dict[str, str]:
        """返回 run 到 prompt 的映射，供 transcript 合并轮次。"""

        stmt = (
            select(agent_job_runs_table.c.run_id, agent_job_runs_table.c.prompt_id)
            .join(
                agent_jobs_table, agent_jobs_table.c.prompt_id == agent_job_runs_table.c.prompt_id
            )
            .where(agent_jobs_table.c.conversation_id == conversation_id)
        )
        async with self._engine.connect() as conn:
            return {run_id: prompt_id for run_id, prompt_id in (await conn.execute(stmt)).all()}

    async def prompt_status_of_runs(self, conversation_id: str) -> dict[str, str]:
        """返回各 run 所属消息的当前状态，供 transcript 判定开放调用的审批或终止状态。"""

        stmt = (
            select(agent_job_runs_table.c.run_id, agent_jobs_table.c.status)
            .join(
                agent_jobs_table, agent_jobs_table.c.prompt_id == agent_job_runs_table.c.prompt_id
            )
            .where(agent_jobs_table.c.conversation_id == conversation_id)
        )
        async with self._engine.connect() as conn:
            return {run_id: status for run_id, status in (await conn.execute(stmt)).all()}

    async def activities(self, conversation_ids: Sequence[str]) -> dict[str, ActivityState]:
        """从持久化队列查询各会话活动，未命中时返回 IDLE。"""

        if not conversation_ids:
            return {}
        decisive = await self._decisive(
            agent_jobs_table.c.conversation_id.in_(tuple(conversation_ids))
        )
        return {one: activity_of(decisive.get(one)) for one in conversation_ids}

    async def conversation_ids(
        self, owner_user_id: uuid.UUID, state: Literal["running", "done"]
    ) -> frozenset[str]:
        """查询属主的活跃会话与已运行会话；从未运行的会话不在结果中。"""

        decisive = await self._decisive(agent_jobs_table.c.owner_user_id == owner_user_id)
        return frozenset(
            conversation_id
            for conversation_id, status in decisive.items()
            if activity_of(status).busy == (state == "running")
        )

    async def _decisive(self, scope: ColumnElement[bool]) -> dict[str, JobStatus]:
        """优先取占用会话的行，否则取最近结束的运行。

        排除 steered、queued 以及未启动便撤回的消息，避免其覆盖审批状态或最近运行结果。
        """

        stmt = (
            select(agent_jobs_table.c.conversation_id, agent_jobs_table.c.status)
            .where(scope)
            .where(agent_jobs_table.c.status.not_in(("queued", "steered")))
            .where(
                ~and_(agent_jobs_table.c.status == "aborted", agent_jobs_table.c.run_id.is_(None))
            )
            .distinct(agent_jobs_table.c.conversation_id)
            .order_by(
                agent_jobs_table.c.conversation_id,
                agent_jobs_table.c.status.in_(_ACTIVE).desc(),
                agent_jobs_table.c.finished_at.desc().nulls_last(),
                agent_jobs_table.c.created_at.desc(),
            )
        )
        async with self._engine.connect() as conn:
            return {
                conversation_id: cast("JobStatus", status)
                for conversation_id, status in (await conn.execute(stmt)).all()
            }

    async def start_next(self, conversation_id: str, *, locked_by: str) -> JobRow | None:
        """原子认领队首并创建租约；会话仍被占用、队列为空或并发认领失败时返回 None。"""

        head = (
            select(agent_jobs_table.c.prompt_id)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status == "queued")
            .order_by(agent_jobs_table.c.created_at.asc(), agent_jobs_table.c.prompt_id.asc())
            .limit(1)
            .scalar_subquery()
        )
        running = (
            select(agent_jobs_table.c.prompt_id)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status.in_(_ACTIVE))
        )
        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.prompt_id == head)
            .where(~exists(running))
            .values(status="running", locked_by=locked_by, heartbeat_at=func.now())
            .returning(agent_jobs_table)
        )
        try:
            row = await self._one(stmt)
        except IntegrityError:
            return None
        if row is not None:
            self._changed(row, row.status)
        return row

    async def attach_run(
        self, prompt_id: str, run_id: str, *, locked_by: str, attempt: int
    ) -> None:
        """持租写入最近 run_id 与完整运行映射；两项更新同事务提交，避免 transcript 错分轮次。"""

        claim = (
            update(agent_jobs_table)
            .where(_owned(prompt_id, locked_by, attempt))
            .values(run_id=run_id)
        )
        async with self._engine.begin() as conn:
            if (await conn.execute(claim)).rowcount != 1:
                return
            await conn.execute(
                insert(agent_job_runs_table).values(
                    run_id=run_id, prompt_id=prompt_id, started_at=func.now()
                )
            )

    async def finish(
        self, prompt_id: str, *, status: JobStatus, now: datetime, locked_by: str, attempt: int
    ) -> None:
        """仅结束仍由当前租约持有的消息。"""

        stmt = (
            update(agent_jobs_table)
            .where(_owned(prompt_id, locked_by, attempt))
            .where(agent_jobs_table.c.status.in_(_LIVE))
            .values(status=status, finished_at=now)
            .returning(agent_jobs_table)
        )
        row = await self._one(stmt)
        if row is not None:
            self._changed(row, status)

    async def abort(self, prompt_id: str, *, conversation_id: str, now: datetime) -> JobRow:
        """撤回指定会话的消息。

        queued/awaiting 使用状态 CAS；running 交由运行侧停止，此处原样返回。
        CAS 同时匹配已授权的 conversation_id，终态消息抛 Conflict。run_id 可区分审批与排队撤回。
        """

        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.prompt_id == prompt_id)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status.in_(("queued", "awaiting")))
            .values(status="aborted", finished_at=now)
            .returning(agent_jobs_table)
        )
        aborted = await self._one(stmt)
        if aborted is not None:
            if aborted.run_id is not None:
                self._changed(aborted, "aborted")
            return aborted
        row = await self.get(prompt_id)
        if row is None or row.conversation_id != conversation_id:
            raise NotFound(f"没有这条消息：{prompt_id}")
        if row.status == "steered":
            raise Conflict("这条消息已经递进当前这一轮了，要停就停整段对话")
        if row.status != "running":
            raise Conflict("这条消息已经结束了，停不了")
        return row

    async def abort_queued(self, conversation_id: str, *, now: datetime) -> tuple[JobRow, ...]:
        """单条 UPDATE 撤回全部排队消息，避免逐条更新期间队首被 start_next 启动。"""

        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status == "queued")
            .values(status="aborted", finished_at=now)
            .returning(agent_jobs_table)
        )
        return await self._all(stmt)

    async def pick_for_steer(
        self, conversation_id: str, prompt_ids: tuple[str, ...]
    ) -> tuple[JobRow, ...]:
        """验证整批插话均属于当前会话且处于 queued，验证失败时整批拒绝。"""

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
    ) -> tuple[JobRow, ...]:
        """递入内容前先记录 steered 与 run_id，确保运行结束时能将未消费消息退回队列。"""

        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.prompt_id.in_(prompt_ids))
            .where(agent_jobs_table.c.status == "queued")
            .values(status="steered", run_id=run_id, steered_at=now)
            .returning(agent_jobs_table)
        )
        return await self._all(stmt)

    async def settle_steered(
        self, run_id: str, *, status: JobStatus, now: datetime
    ) -> tuple[JobRow, ...]:
        """将插话更新为所属 run 的终态。"""

        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.run_id == run_id)
            .where(agent_jobs_table.c.status == "steered")
            .values(status=status, finished_at=now)
            .returning(agent_jobs_table)
        )
        return await self._all(stmt)

    async def requeue_steered(self, prompt_ids: tuple[str, ...]) -> tuple[JobRow, ...]:
        """将运行结束时未消费的插话退回 queued。"""

        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.prompt_id.in_(prompt_ids))
            .where(agent_jobs_table.c.status == "steered")
            .values(status="queued", run_id=None, steered_at=None)
            .returning(agent_jobs_table)
        )
        return await self._all(stmt)

    async def heartbeat(self, *, locked_by: str) -> tuple[str, ...]:
        """刷新当前进程的运行租约，返回成功更新的消息 id，供调用方识别失租运行。"""

        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.locked_by == locked_by)
            .where(agent_jobs_table.c.status == "running")
            .values(heartbeat_at=func.now())
            .returning(agent_jobs_table.c.prompt_id)
        )
        async with self._engine.begin() as conn:
            return tuple((await conn.execute(stmt)).scalars().all())

    async def release(self, prompt_id: str, *, locked_by: str, reason: str, attempt: int) -> None:
        """释放当前租约并保留 running，等待其他进程续跑；会话活动未变，不广播。"""

        stmt = (
            update(agent_jobs_table)
            .where(_owned(prompt_id, locked_by, attempt))
            .where(agent_jobs_table.c.status == "running")
            .values(locked_by=None, heartbeat_at=None, interrupt_reason=reason)
        )
        await self._one(stmt.returning(agent_jobs_table))

    async def claim_interrupted(
        self, *, locked_by: str, lease_seconds: int, max_attempts: int
    ) -> tuple[JobRow, ...]:
        """认领其他进程的中断运行。

        attempt 不含首次认领，使用 attempt + 1 判断上限。排除本进程持有的行，避免事件循环阻塞后
        重复启动；IS DISTINCT FROM 允许认领 locked_by 为 NULL 的已释放租约。
        """

        stmt = (
            update(agent_jobs_table)
            .where(_interrupted(lease_seconds))
            .where(agent_jobs_table.c.locked_by.is_distinct_from(locked_by))
            .where(agent_jobs_table.c.attempt + 1 < max_attempts)
            .values(
                locked_by=locked_by,
                heartbeat_at=func.now(),
                attempt=agent_jobs_table.c.attempt + 1,
            )
            .returning(agent_jobs_table)
        )
        return await self._all(stmt)

    async def fail_exhausted(self, *, lease_seconds: int, max_attempts: int) -> tuple[JobRow, ...]:
        """将认领次数耗尽的中断消息标记失败并释放租约。"""

        stmt = (
            update(agent_jobs_table)
            .where(_interrupted(lease_seconds))
            .where(agent_jobs_table.c.attempt + 1 >= max_attempts)
            .values(
                status="failed",
                finished_at=func.now(),
                locked_by=None,
                interrupt_reason=f"中断 {max_attempts} 次后放弃续跑",
            )
            .returning(agent_jobs_table)
        )
        rows = await self._all(stmt)
        for row in rows:
            self._changed(row, "failed")
        return rows

    async def adopt_steered(self, old_run_id: str, new_run_id: str) -> None:
        """将旧 run 的插话迁移至续跑 run，确保其终态随续跑更新。"""

        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.status == "steered")
            .where(agent_jobs_table.c.run_id == old_run_id)
            .values(run_id=new_run_id)
        )
        await self._all(stmt.returning(agent_jobs_table))

    async def await_approvals(
        self, prompt_id: str, *, locked_by: str, attempt: int
    ) -> JobRow | None:
        """持租转入 awaiting 并释放租约，保留 run_id；避免清扫将审批等待误判为中断。"""

        stmt = (
            update(agent_jobs_table)
            .where(_owned(prompt_id, locked_by, attempt))
            .where(agent_jobs_table.c.status == "running")
            .values(status="awaiting", locked_by=None, heartbeat_at=None)
            .returning(agent_jobs_table)
        )
        row = await self._one(stmt)
        if row is not None:
            self._changed(row, "awaiting")
        return row

    async def record_decision(self, prompt_id: str, tool_call_id: str, *, approved: bool) -> JobRow:
        """事务内加锁更新审批决定，防止并发覆盖。重复相同决定幂等，冲突决定抛 Conflict。"""

        async with self._engine.begin() as conn:
            current = (
                await conn.execute(
                    select(agent_jobs_table)
                    .where(agent_jobs_table.c.prompt_id == prompt_id)
                    .where(agent_jobs_table.c.status == "awaiting")
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
                    update(agent_jobs_table)
                    .where(agent_jobs_table.c.prompt_id == prompt_id)
                    .values(decisions=json.dumps(decisions, ensure_ascii=False))
                    .returning(agent_jobs_table)
                )
            ).one()
        return _row(updated)

    async def claim_for_continuation(self, prompt_id: str, *, locked_by: str) -> JobRow | None:
        """审批齐备后 CAS 转回 running 并创建租约。保留 decisions 供续跑使用，不增加中断次数。"""

        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.prompt_id == prompt_id)
            .where(agent_jobs_table.c.status == "awaiting")
            .values(status="running", locked_by=locked_by, heartbeat_at=func.now())
            .returning(agent_jobs_table)
        )
        row = await self._one(stmt)
        if row is not None:
            self._changed(row, "running")
        return row

    async def conversations_waiting(self) -> tuple[str, ...]:
        """查询有排队消息且执行位置空闲的会话。"""

        queued = agent_jobs_table.alias("queued")
        running = (
            select(agent_jobs_table.c.prompt_id)
            .where(agent_jobs_table.c.conversation_id == queued.c.conversation_id)
            .where(agent_jobs_table.c.status.in_(_ACTIVE))
        )
        stmt = (
            select(queued.c.conversation_id)
            .where(queued.c.status == "queued")
            .where(~exists(running))
            .distinct()
        )
        async with self._engine.connect() as conn:
            return tuple((await conn.execute(stmt)).scalars().all())

    # --- 执行 ---------------------------------------------------------------

    async def _one(self, stmt: Executable) -> JobRow | None:
        """执行写入并返回单条 RETURNING 记录，未更新时返回 None。"""

        async with self._engine.begin() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        return None if row is None else _row(row)

    async def _all(self, stmt: Executable) -> tuple[JobRow, ...]:
        """执行写入并返回全部 RETURNING 记录。"""

        async with self._engine.begin() as conn:
            return tuple(_row(row) for row in (await conn.execute(stmt)).all())

    async def _rows(self, stmt: Executable) -> tuple[JobRow, ...]:
        """执行只读查询，不开启显式事务。"""

        async with self._engine.connect() as conn:
            return tuple(_row(row) for row in (await conn.execute(stmt)).all())


def _owned(prompt_id: str, locked_by: str, attempt: int) -> ColumnElement[bool]:
    """写入同时校验 id、locked_by 和 attempt。attempt 防止同一进程重新认领后被旧任务的延迟写入覆盖。"""

    return and_(
        agent_jobs_table.c.prompt_id == prompt_id,
        agent_jobs_table.c.locked_by == locked_by,
        agent_jobs_table.c.attempt == attempt,
    )


def _interrupted(lease_seconds: int) -> ColumnElement[bool]:
    """统一判定 running 行的租约释放或心跳超时。释放后的 NULL 心跳单独处理；awaiting 不参与清扫。"""

    return and_(
        agent_jobs_table.c.status == "running",
        or_(
            agent_jobs_table.c.locked_by.is_(None),
            agent_jobs_table.c.heartbeat_at < func.now() - timedelta(seconds=lease_seconds),
        ),
    )


_CONTENT = TypeAdapter(tuple[PromptContent, ...])
_DECISIONS = TypeAdapter(dict[str, bool])


def _dump(content: tuple[PromptContent, ...]) -> str:
    return json.dumps(
        [part.model_dump(by_alias=True, exclude_none=True) for part in content],
        ensure_ascii=False,
    )


class _JobRow:
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


def _row(row: object) -> JobRow:
    r = cast("_JobRow", row)
    return JobRow(
        prompt_id=r.prompt_id,
        conversation_id=r.conversation_id,
        agent_id=r.agent_id,
        owner_user_id=r.owner_user_id,
        content=_CONTENT.validate_json(r.content),
        status=cast("JobStatus", r.status),
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
    "ActivityChanged",
    "JobQueue",
    "JobQueueView",
    "JobRow",
    "JobStatus",
    "agent_job_runs_table",
    "agent_jobs_table",
    "metadata_obj",
]
