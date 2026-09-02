"""官方 pydantic_ai_harness StepPersistence 的 Postgres 后端。

表结构严格镜像官方 ``SqliteStepStore`` / ``SqliteMediaStore``（决策：严格复用
官方结构，仅替换数据库实现）；DDL 由 Alembic 迁移拥有，store 不自建表。

``messages`` / ``metadata`` 存 JSON 文本（text 而非 jsonb）：jsonb 会解析并
拒绝字符串中的 ``\\u0000`` 转义，text 保证官方后端能写入的任何负载这里同样
能写入；读取一律回到 Python 反序列化，不依赖 SQL 内查询 JSON。
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Final, Literal, cast, get_args

from pydantic_ai.messages import ModelMessage, ModelMessagesTypeAdapter
from pydantic_ai_harness.media import (
    MediaContext,
    MediaStore,
    externalize_media,
    media_uri_for,
    parse_media_uri,
    restore_media,
)
from pydantic_ai_harness.step_persistence import (
    ContinuableSnapshot,
    EventKind,
    RunRecord,
    SnapshotState,
    StepEvent,
    ToolEffectRecord,
    ToolEffectStatus,
)
from sqlalchemy import (
    BigInteger,
    Column,
    Identity,
    Index,
    Integer,
    LargeBinary,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    delete,
    select,
    text,
    union,
)
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine

_logger = logging.getLogger(__name__)

DB_SCHEMA: Final = "agent_runtime"

# 官方 SqliteStepStore 的默认外置阈值（私有常量，镜像其值）。
_DEFAULT_MEDIA_THRESHOLD_BYTES: Final = 64 * 1024

_EVENT_KINDS: Final[frozenset[str]] = frozenset(get_args(EventKind))
_TOOL_STATUSES: Final[frozenset[str]] = frozenset(get_args(ToolEffectStatus))
_SNAPSHOT_STATES: Final[frozenset[str]] = frozenset(get_args(SnapshotState))

_EMPTY_CONTEXT: Final = MediaContext()

metadata_obj = MetaData(schema=DB_SCHEMA)

runs_table = Table(
    "runs",
    metadata_obj,
    Column("run_id", Text, primary_key=True),
    Column("conversation_id", Text),
    Column("parent_run_id", Text),
    Column("agent_name", Text),
    Column("metadata", Text, nullable=False),
    Column("started_at", TIMESTAMP(timezone=True), nullable=False),
    Column("registration_id", Text),
    Index("idx_runs_conv", "conversation_id"),
    Index("idx_runs_parent", "parent_run_id"),
    Index("idx_runs_started", "started_at"),
)

events_table = Table(
    "events",
    metadata_obj,
    Column("seq", BigInteger, Identity(always=True), primary_key=True),
    Column("run_id", Text, nullable=False),
    Column("kind", Text, nullable=False),
    Column("step_index", Integer, nullable=False),
    Column("timestamp", TIMESTAMP(timezone=True), nullable=False),
    Column("conversation_id", Text),
    Column("parent_run_id", Text),
    Column("agent_name", Text),
    Column("tool_call_id", Text),
    Column("tool_name", Text),
    Column("error", Text),
    Column("metadata", Text, nullable=False),
    Column("idempotency_key", Text),
    Index("idx_events_run", "run_id", "seq"),
    Index(
        "idx_events_idempotency",
        "run_id",
        "idempotency_key",
        unique=True,
        postgresql_where=text("idempotency_key IS NOT NULL"),
    ),
)

snapshots_table = Table(
    "snapshots",
    metadata_obj,
    Column("seq", BigInteger, Identity(always=True), primary_key=True),
    Column("run_id", Text, nullable=False),
    Column("step_index", Integer, nullable=False),
    Column("conversation_id", Text),
    Column("parent_run_id", Text),
    Column("agent_name", Text),
    Column("timestamp", TIMESTAMP(timezone=True), nullable=False),
    Column("state", Text, nullable=False, server_default="complete"),
    Column("messages", Text, nullable=False),
    Column("idempotency_key", Text),
    Index("idx_snapshots_run", "run_id", "seq"),
)

# 快照键单独一张表：修剪删掉的那些快照，键要留下来继续挡住重放里的同一次保存。
snapshot_idempotency_keys_table = Table(
    "snapshot_idempotency_keys",
    metadata_obj,
    Column("run_id", Text, nullable=False),
    Column("idempotency_key", Text, nullable=False),
    PrimaryKeyConstraint("run_id", "idempotency_key"),
)

tool_effects_table = Table(
    "tool_effects",
    metadata_obj,
    Column("run_id", Text, nullable=False),
    Column("tool_call_id", Text, nullable=False),
    Column("tool_name", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("started_at", TIMESTAMP(timezone=True), nullable=False),
    Column("ended_at", TIMESTAMP(timezone=True)),
    Column("idempotency_key", Text),
    Column("effect_summary", Text),
    PrimaryKeyConstraint("run_id", "tool_call_id"),
)

media_table = Table(
    "media",
    metadata_obj,
    Column("sha256", Text, primary_key=True),
    Column("media_type", Text),
    Column("bytes", LargeBinary, nullable=False),
    Column("size_bytes", BigInteger, nullable=False),
    Column("metadata", Text),
)


def _str_str_dict(raw: object) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise ValueError(f"metadata payload must be a JSON object, got {type(raw).__name__}")
    out: dict[str, str] = {}
    for key, value in cast("dict[object, object]", raw).items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise ValueError(f"metadata entries must be str→str, got {key!r}: {value!r}")
        out[key] = value
    return out


def _event_kind(raw: object) -> EventKind:
    if isinstance(raw, str) and raw in _EVENT_KINDS:
        return cast(EventKind, raw)
    raise ValueError(f"unknown event kind {raw!r}")


def _tool_status(raw: object) -> ToolEffectStatus:
    if isinstance(raw, str) and raw in _TOOL_STATUSES:
        return cast(ToolEffectStatus, raw)
    raise ValueError(f"unknown tool-effect status {raw!r}")


def _snapshot_state(raw: object) -> SnapshotState:
    if isinstance(raw, str) and raw in _SNAPSHOT_STATES:
        return cast(SnapshotState, raw)
    raise ValueError(f"unknown snapshot state {raw!r}")


class PgMediaStore:
    """实现官方 ``MediaStore`` 协议：内容寻址的字节存储，一行一 blob。

    与官方 ``SqliteMediaStore`` 同构：sha256 主键、``ON CONFLICT DO NOTHING``
    幂等写入、metadata 存 JSON 文本。``public_url`` 恒为 ``None``（本部署无
    模型可直取的公网媒体地址）。
    """

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def put(self, data: bytes, *, context: MediaContext = _EMPTY_CONTEXT) -> str:
        uri = media_uri_for(data)
        stmt = (
            pg_insert(media_table)
            .values(
                sha256=parse_media_uri(uri),
                media_type=context.media_type,
                bytes=data,
                size_bytes=len(data),
                metadata=json.dumps(dict(context.metadata)),
            )
            .on_conflict_do_nothing(index_elements=["sha256"])
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)
        return uri

    async def get(self, uri: str, *, context: MediaContext = _EMPTY_CONTEXT) -> bytes:
        digest = parse_media_uri(uri)
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(media_table.c.bytes).where(media_table.c.sha256 == digest)
                )
            ).one_or_none()
        if row is None:
            raise FileNotFoundError(f"media not found: {digest}")
        return bytes(row[0])

    async def exists(self, uri: str, *, context: MediaContext = _EMPTY_CONTEXT) -> bool:
        digest = parse_media_uri(uri)
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(media_table.c.sha256).where(media_table.c.sha256 == digest)
                )
            ).one_or_none()
        return row is not None

    async def public_url(self, uri: str, *, context: MediaContext = _EMPTY_CONTEXT) -> str | None:
        return None

    async def get_metadata(
        self, uri: str, *, context: MediaContext = _EMPTY_CONTEXT
    ) -> dict[str, str]:
        digest = parse_media_uri(uri)
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(media_table.c.metadata).where(media_table.c.sha256 == digest)
                )
            ).one_or_none()
        if row is None:
            raise FileNotFoundError(f"media not found: {digest}")
        raw = cast("str | None", row[0])
        if raw is None:
            return {}
        return _str_str_dict(json.loads(raw))


class PgStepStore:
    """实现官方 ``StepStore`` 协议的 Postgres 后端。

    语义逐条对齐官方 ``SqliteStepStore``：``register_run`` 单发（重复主键让
    IntegrityError 上抛，capability 的 ``before_run`` 已做预检）；
    ``list_runs`` 按 ``started_at`` 升序（协议约定）；快照默认只读
    ``complete``；``tool_effects`` 按 ``(run_id, tool_call_id)`` upsert；
    ``max_snapshots_per_run`` 的保留集 = 最新 keep 条 ∪ 最新一条 complete。

    带幂等键的追加与保存只落一次：事件靠部分唯一索引挡，快照靠 ``snapshot_idempotency_keys``
    抢键——键没抢到就整条不落地，也不修剪（官方是插进去再由触发器忽略、修剪照跑，落库结果一样）。
    """

    def __init__(
        self,
        engine: AsyncEngine,
        *,
        media_store: MediaStore | Literal["auto"] | None = "auto",
        media_threshold_bytes: int = _DEFAULT_MEDIA_THRESHOLD_BYTES,
        max_snapshots_per_run: int | None = None,
    ) -> None:
        if max_snapshots_per_run is not None and max_snapshots_per_run < 1:
            raise ValueError(
                f"max_snapshots_per_run must be an int >= 1 or None, got {max_snapshots_per_run!r}"
            )
        self._engine = engine
        self._max_snapshots_per_run = max_snapshots_per_run
        self._media_store: MediaStore | None = (
            PgMediaStore(engine) if media_store == "auto" else media_store
        )
        self._media_threshold_bytes = media_threshold_bytes

    # -- runs -----------------------------------------------------------------

    async def register_run(self, record: RunRecord) -> None:
        stmt = runs_table.insert().values(
            run_id=record.run_id,
            conversation_id=record.conversation_id,
            parent_run_id=record.parent_run_id,
            agent_name=record.agent_name,
            metadata=json.dumps(dict(record.metadata)),
            started_at=record.started_at,
            registration_id=record.registration_id,
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)

    async def get_run(self, *, run_id: str) -> RunRecord | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(select(runs_table).where(runs_table.c.run_id == run_id))
            ).one_or_none()
        if row is None:
            return None
        return RunRecord(
            run_id=row.run_id,
            conversation_id=row.conversation_id,
            parent_run_id=row.parent_run_id,
            agent_name=row.agent_name,
            metadata=_str_str_dict(json.loads(row.metadata)),
            started_at=row.started_at,
            registration_id=row.registration_id,
        )

    async def list_runs(
        self,
        *,
        parent_run_id: str | None = None,
        conversation_id: str | None = None,
    ) -> list[RunRecord]:
        stmt = select(runs_table).order_by(runs_table.c.started_at.asc())
        if parent_run_id is not None:
            stmt = stmt.where(runs_table.c.parent_run_id == parent_run_id)
        if conversation_id is not None:
            stmt = stmt.where(runs_table.c.conversation_id == conversation_id)
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        return [
            RunRecord(
                run_id=row.run_id,
                conversation_id=row.conversation_id,
                parent_run_id=row.parent_run_id,
                agent_name=row.agent_name,
                metadata=_str_str_dict(json.loads(row.metadata)),
                started_at=row.started_at,
                registration_id=row.registration_id,
            )
            for row in rows
        ]

    # -- events ---------------------------------------------------------------

    async def append_event(self, event: StepEvent) -> None:
        stmt = pg_insert(events_table).values(
            run_id=event.run_id,
            kind=event.kind,
            step_index=event.step_index,
            timestamp=event.timestamp,
            conversation_id=event.conversation_id,
            parent_run_id=event.parent_run_id,
            agent_name=event.agent_name,
            tool_call_id=event.tool_call_id,
            tool_name=event.tool_name,
            error=event.error,
            metadata=json.dumps(dict(event.metadata)),
            idempotency_key=event.idempotency_key,
        )
        if event.idempotency_key is not None:
            # index_where 必须和部分唯一索引的条件一字不差，否则 PG 找不到仲裁索引直接报错。
            stmt = stmt.on_conflict_do_nothing(
                index_elements=["run_id", "idempotency_key"],
                index_where=events_table.c.idempotency_key.isnot(None),
            )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)

    async def list_events(self, *, run_id: str) -> list[StepEvent]:
        stmt = (
            select(events_table)
            .where(events_table.c.run_id == run_id)
            .order_by(events_table.c.seq.asc())
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        return [
            StepEvent(
                run_id=row.run_id,
                kind=_event_kind(row.kind),
                step_index=row.step_index,
                timestamp=row.timestamp,
                conversation_id=row.conversation_id,
                parent_run_id=row.parent_run_id,
                agent_name=row.agent_name,
                tool_call_id=row.tool_call_id,
                tool_name=row.tool_name,
                error=row.error,
                metadata=_str_str_dict(json.loads(row.metadata)),
                idempotency_key=row.idempotency_key,
            )
            for row in rows
        ]

    # -- snapshots ------------------------------------------------------------

    async def save_snapshot(self, snapshot: ContinuableSnapshot) -> None:
        messages_json: object = json.loads(
            ModelMessagesTypeAdapter.dump_json(snapshot.messages).decode("utf-8")
        )
        if self._media_store is not None:
            messages_json = await externalize_media(
                messages_json,
                media_store=self._media_store,
                threshold_bytes=self._media_threshold_bytes,
            )
        insert_stmt = snapshots_table.insert().values(
            run_id=snapshot.run_id,
            step_index=snapshot.step_index,
            conversation_id=snapshot.conversation_id,
            parent_run_id=snapshot.parent_run_id,
            agent_name=snapshot.agent_name,
            timestamp=snapshot.timestamp,
            state=snapshot.state,
            messages=json.dumps(messages_json),
            idempotency_key=snapshot.idempotency_key,
        )
        async with self._engine.begin() as conn:
            if snapshot.idempotency_key is not None:
                # 抢键和插快照必须同一个事务，否则中途崩掉会留下没有快照的键，那次保存就永久丢了。
                claimed = (
                    await conn.execute(
                        pg_insert(snapshot_idempotency_keys_table)
                        .values(
                            run_id=snapshot.run_id,
                            idempotency_key=snapshot.idempotency_key,
                        )
                        .on_conflict_do_nothing()
                        .returning(snapshot_idempotency_keys_table.c.run_id)
                    )
                ).first()
                if claimed is None:
                    return
            await conn.execute(insert_stmt)
            if self._max_snapshots_per_run is not None:
                newest_keep = (
                    select(snapshots_table.c.seq)
                    .where(snapshots_table.c.run_id == snapshot.run_id)
                    .order_by(snapshots_table.c.seq.desc())
                    .limit(self._max_snapshots_per_run)
                )
                newest_complete = (
                    select(snapshots_table.c.seq)
                    .where(
                        snapshots_table.c.run_id == snapshot.run_id,
                        snapshots_table.c.state == "complete",
                    )
                    .order_by(snapshots_table.c.seq.desc())
                    .limit(1)
                )
                await conn.execute(
                    delete(snapshots_table).where(
                        snapshots_table.c.run_id == snapshot.run_id,
                        snapshots_table.c.seq.not_in(union(newest_keep, newest_complete)),
                    )
                )

    async def latest_snapshot(
        self, *, run_id: str, include_interrupted: bool = False
    ) -> ContinuableSnapshot | None:
        stmt = select(snapshots_table).where(snapshots_table.c.run_id == run_id)
        if not include_interrupted:
            stmt = stmt.where(snapshots_table.c.state == "complete")
        stmt = stmt.order_by(snapshots_table.c.seq.desc()).limit(1)
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        if row is None:
            return None
        return await self._snapshot_from_row(run_id, row)

    async def latest_conversation_snapshot(
        self, *, conversation_id: str, include_interrupted: bool = False
    ) -> ContinuableSnapshot | None:
        """这段对话最新的一份快照（非协议方法）。

        快照按运行分片存，但 ``seq`` 是全表自增的，所以「最新的一份」一句 SQL 就能取
        到，不必先列运行再逐个问。派活出去的下属另有自己的会话 id，不会混进来。

        默认只给完整的那些，与官方 ``latest_snapshot`` 同一个口径：中断的快照里有悬空的工具调
        用，接着跑可能把那次调用再执行一遍，而副作用发生过没有只有工具账本说得清。
        ``include_interrupted=True`` 是给**显示**用的——把一段中断的对话画出来不产生任何副作用。
        """

        stmt = select(snapshots_table).where(snapshots_table.c.conversation_id == conversation_id)
        if not include_interrupted:
            stmt = stmt.where(snapshots_table.c.state == "complete")
        stmt = stmt.order_by(snapshots_table.c.seq.desc()).limit(1)
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        if row is None:
            return None
        return await self._snapshot_from_row(cast("_SnapshotRow", row).run_id, row)

    async def list_snapshots(
        self, *, run_id: str, include_interrupted: bool = False
    ) -> list[ContinuableSnapshot]:
        """写入序返回保留的快照；坏行跳过并记日志（对齐官方，非协议方法）。"""
        stmt = select(snapshots_table).where(snapshots_table.c.run_id == run_id)
        if not include_interrupted:
            stmt = stmt.where(snapshots_table.c.state == "complete")
        stmt = stmt.order_by(snapshots_table.c.seq.asc())
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        snapshots: list[ContinuableSnapshot] = []
        for row in rows:
            try:
                snapshots.append(await self._snapshot_from_row(run_id, row))
            except Exception:
                _logger.warning(
                    "Skipping unparsable snapshot row for run %s", run_id, exc_info=True
                )
        return snapshots

    async def _snapshot_from_row(self, run_id: str, row: object) -> ContinuableSnapshot:
        r = cast("_SnapshotRow", row)
        messages_json: object = json.loads(r.messages)
        if self._media_store is not None:
            messages_json = await restore_media(messages_json, media_store=self._media_store)
        messages: list[ModelMessage] = ModelMessagesTypeAdapter.validate_python(messages_json)
        return ContinuableSnapshot(
            run_id=run_id,
            step_index=r.step_index,
            messages=messages,
            conversation_id=r.conversation_id,
            parent_run_id=r.parent_run_id,
            agent_name=r.agent_name,
            timestamp=r.timestamp,
            state=_snapshot_state(r.state),
            idempotency_key=r.idempotency_key,
        )

    # -- tool effects ---------------------------------------------------------

    async def record_tool_effect(self, record: ToolEffectRecord) -> None:
        stmt = pg_insert(tool_effects_table).values(
            run_id=record.run_id,
            tool_call_id=record.tool_call_id,
            tool_name=record.tool_name,
            status=record.status,
            started_at=record.started_at,
            ended_at=record.ended_at,
            idempotency_key=record.idempotency_key,
            effect_summary=record.effect_summary,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["run_id", "tool_call_id"],
            set_={
                "tool_name": stmt.excluded.tool_name,
                "status": stmt.excluded.status,
                "started_at": stmt.excluded.started_at,
                "ended_at": stmt.excluded.ended_at,
                "idempotency_key": stmt.excluded.idempotency_key,
                "effect_summary": stmt.excluded.effect_summary,
            },
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)

    async def get_tool_effect(self, *, run_id: str, tool_call_id: str) -> ToolEffectRecord | None:
        stmt = select(tool_effects_table).where(
            tool_effects_table.c.run_id == run_id,
            tool_effects_table.c.tool_call_id == tool_call_id,
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        if row is None:
            return None
        return self._tool_effect_from_row(row)

    async def list_unresolved_tool_effects(self, *, run_id: str) -> list[ToolEffectRecord]:
        stmt = select(tool_effects_table).where(
            tool_effects_table.c.run_id == run_id,
            tool_effects_table.c.status == "started",
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        return [self._tool_effect_from_row(row) for row in rows]

    @staticmethod
    def _tool_effect_from_row(row: object) -> ToolEffectRecord:
        r = cast("_ToolEffectRow", row)
        return ToolEffectRecord(
            tool_call_id=r.tool_call_id,
            tool_name=r.tool_name,
            run_id=r.run_id,
            status=_tool_status(r.status),
            started_at=r.started_at,
            ended_at=r.ended_at,
            idempotency_key=r.idempotency_key,
            effect_summary=r.effect_summary,
        )


class _SnapshotRow:
    """快照行的结构声明（仅供类型检查，运行时是 SQLAlchemy Row）。"""

    run_id: str
    step_index: int
    conversation_id: str | None
    parent_run_id: str | None
    agent_name: str | None
    timestamp: datetime
    state: str
    messages: str
    idempotency_key: str | None


class _ToolEffectRow:
    run_id: str
    tool_call_id: str
    tool_name: str
    status: str
    started_at: datetime
    ended_at: datetime | None
    idempotency_key: str | None
    effect_summary: str | None
