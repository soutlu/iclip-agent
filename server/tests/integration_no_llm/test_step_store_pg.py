"""验证 PgStepStore、PgMediaStore 与 StepPersistence 的持久化协议一致性。"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import (
    BinaryContent,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai_harness.step_persistence import (
    ContinuableSnapshot,
    RunRecord,
    StepEvent,
    StepPersistence,
    StepStore,
    ToolEffectRecord,
    continue_run,
)
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.harness.step_store_pg import PgMediaStore, PgStepStore

T0 = datetime(2026, 8, 21, 10, 0, 0, tzinfo=UTC)


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "TRUNCATE agent_runtime.runs, agent_runtime.events, "
                "agent_runtime.snapshots, agent_runtime.snapshot_idempotency_keys, "
                "agent_runtime.tool_effects, agent_runtime.media"
            )
        )
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
def store(engine: AsyncEngine) -> PgStepStore:
    return PgStepStore(engine)


def _messages(text_content: str = "hello") -> list[ModelMessage]:
    return [
        ModelRequest(parts=[UserPromptPart(content=text_content)]),
        ModelResponse(parts=[TextPart(content=f"re: {text_content}")]),
    ]


def _dump(messages: list[ModelMessage]) -> bytes:
    return ModelMessagesTypeAdapter.dump_json(messages)


async def test_satisfies_official_protocol(store: PgStepStore) -> None:
    assert isinstance(store, StepStore)


async def test_register_run_roundtrip_and_single_shot(store: PgStepStore) -> None:
    record = RunRecord(
        run_id="r1",
        conversation_id="conv-1",
        parent_run_id="r0",
        agent_name="probe",
        metadata={"k": "v"},
        started_at=T0,
        registration_id="reg-1",
    )
    await store.register_run(record)

    loaded = await store.get_run(run_id="r1")
    assert loaded == record
    assert await store.get_run(run_id="missing") is None

    with pytest.raises(IntegrityError):
        await store.register_run(record)


async def test_list_runs_order_and_filters(store: PgStepStore) -> None:
    def rec(run_id: str, offset_s: int, conv: str | None, parent: str | None) -> RunRecord:
        return RunRecord(
            run_id=run_id,
            conversation_id=conv,
            parent_run_id=parent,
            started_at=T0 + timedelta(seconds=offset_s),
        )

    # 乱序写入，验证按 started_at 升序读出（协议约定）。
    await store.register_run(rec("b", 20, "conv-1", "root"))
    await store.register_run(rec("a", 10, "conv-1", None))
    await store.register_run(rec("c", 30, "conv-2", "root"))

    assert [r.run_id for r in await store.list_runs()] == ["a", "b", "c"]
    assert [r.run_id for r in await store.list_runs(conversation_id="conv-1")] == ["a", "b"]
    assert [r.run_id for r in await store.list_runs(parent_run_id="root")] == ["b", "c"]
    assert [
        r.run_id for r in await store.list_runs(parent_run_id="root", conversation_id="conv-2")
    ] == ["c"]


async def test_event_idempotency_key_suppresses_replay(store: PgStepStore) -> None:
    keyed = StepEvent(
        run_id="r1",
        kind="run_started",
        step_index=0,
        timestamp=T0,
        idempotency_key="0:0:run_started:",
    )
    await store.append_event(keyed)
    await store.append_event(keyed)

    unkeyed = StepEvent(run_id="r1", kind="model_request_started", step_index=1, timestamp=T0)
    await store.append_event(unkeyed)
    await store.append_event(unkeyed)

    events = await store.list_events(run_id="r1")
    assert [e.kind for e in events] == [
        "run_started",
        "model_request_started",
        "model_request_started",
    ]
    assert events[0].idempotency_key == "0:0:run_started:"
    assert events[1].idempotency_key is None


async def test_snapshot_idempotency_key_suppresses_replay(store: PgStepStore) -> None:
    keyed = ContinuableSnapshot(
        run_id="r1",
        step_index=1,
        messages=_messages("s1"),
        state="complete",
        idempotency_key="1:1:complete",
    )
    await store.save_snapshot(keyed)
    await store.save_snapshot(keyed)

    listed = await store.list_snapshots(run_id="r1")
    assert [s.step_index for s in listed] == [1]
    assert listed[0].idempotency_key == "1:1:complete"


async def test_snapshot_idempotency_key_survives_prune(engine: AsyncEngine) -> None:
    """幂等键必须在快照被修剪后保留，以识别旧保存请求的重放。"""
    store = PgStepStore(engine, max_snapshots_per_run=1)
    keyed = ContinuableSnapshot(
        run_id="r1",
        step_index=1,
        messages=_messages("s1"),
        state="complete",
        idempotency_key="1:1:complete",
    )
    await store.save_snapshot(keyed)
    await store.save_snapshot(
        ContinuableSnapshot(run_id="r1", step_index=2, messages=_messages("s2"), state="complete")
    )
    assert [s.step_index for s in await store.list_snapshots(run_id="r1")] == [2]

    await store.save_snapshot(keyed)
    assert [s.step_index for s in await store.list_snapshots(run_id="r1")] == [2]


async def test_snapshot_latest_gate_and_roundtrip(store: PgStepStore) -> None:
    complete = ContinuableSnapshot(
        run_id="r1", step_index=1, messages=_messages("one"), timestamp=T0, state="complete"
    )
    interrupted = ContinuableSnapshot(
        run_id="r1", step_index=2, messages=_messages("two"), timestamp=T0, state="interrupted"
    )
    await store.save_snapshot(complete)
    await store.save_snapshot(interrupted)

    latest = await store.latest_snapshot(run_id="r1")
    assert latest is not None
    assert latest.state == "complete"
    assert _dump(latest.messages) == _dump(complete.messages)

    frontier = await store.latest_snapshot(run_id="r1", include_interrupted=True)
    assert frontier is not None
    assert frontier.state == "interrupted"
    assert _dump(frontier.messages) == _dump(interrupted.messages)

    assert await store.latest_snapshot(run_id="missing") is None

    listed = await store.list_snapshots(run_id="r1", include_interrupted=True)
    assert [s.state for s in listed] == ["complete", "interrupted"]


async def test_snapshot_prune_retain_set(engine: AsyncEngine) -> None:
    """keep=1 且最新的是 interrupted 时，窗口外最新一条 complete 仍须保留。"""
    store = PgStepStore(engine, max_snapshots_per_run=1)
    await store.save_snapshot(
        ContinuableSnapshot(run_id="r1", step_index=1, messages=_messages("s1"), state="complete")
    )
    await store.save_snapshot(
        ContinuableSnapshot(
            run_id="r1", step_index=2, messages=_messages("s2"), state="interrupted"
        )
    )
    await store.save_snapshot(
        ContinuableSnapshot(
            run_id="r1", step_index=3, messages=_messages("s3"), state="interrupted"
        )
    )

    survivors = await store.list_snapshots(run_id="r1", include_interrupted=True)
    assert [s.step_index for s in survivors] == [1, 3]

    latest_complete = await store.latest_snapshot(run_id="r1")
    assert latest_complete is not None and latest_complete.step_index == 1
    frontier = await store.latest_snapshot(run_id="r1", include_interrupted=True)
    assert frontier is not None and frontier.step_index == 3


async def test_snapshot_nul_escape_roundtrip(store: PgStepStore) -> None:
    """jsonb 拒绝含 NUL 转义的负载；text 必须保留该负载。"""
    messages: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content="a\x00b")]),
        ModelResponse(parts=[TextPart(content="ok")]),
    ]
    await store.save_snapshot(
        ContinuableSnapshot(run_id="r-nul", step_index=1, messages=messages, state="complete")
    )
    restored = await store.latest_snapshot(run_id="r-nul")
    assert restored is not None
    assert _dump(restored.messages) == _dump(messages)


async def test_tool_effects_upsert_and_unresolved(store: PgStepStore) -> None:
    started = ToolEffectRecord(
        tool_call_id="tc1", tool_name="fetch", run_id="r1", status="started", started_at=T0
    )
    await store.record_tool_effect(started)
    unresolved = await store.list_unresolved_tool_effects(run_id="r1")
    assert [r.tool_call_id for r in unresolved] == ["tc1"]

    completed = ToolEffectRecord(
        tool_call_id="tc1",
        tool_name="fetch",
        run_id="r1",
        status="completed",
        started_at=T0,
        ended_at=T0 + timedelta(seconds=1),
        idempotency_key="idem-1",
        effect_summary="fetched",
    )
    await store.record_tool_effect(completed)

    assert await store.list_unresolved_tool_effects(run_id="r1") == []
    loaded = await store.get_tool_effect(run_id="r1", tool_call_id="tc1")
    assert loaded == completed
    assert await store.get_tool_effect(run_id="r1", tool_call_id="missing") is None


async def test_media_store_content_addressed(engine: AsyncEngine) -> None:
    from pydantic_ai_harness.media import MediaContext, MediaStore

    media = PgMediaStore(engine)
    assert isinstance(media, MediaStore)

    data = b"payload-bytes"
    uri = await media.put(
        data, context=MediaContext(media_type="text/plain", metadata={"origin": "test"})
    )
    assert await media.put(data) == uri

    assert await media.get(uri) == data
    assert await media.exists(uri)
    assert await media.get_metadata(uri) == {"origin": "test"}
    assert await media.public_url(uri) is None

    absent = "media+sha256://" + "0" * 64
    assert not await media.exists(absent)
    with pytest.raises(FileNotFoundError):
        await media.get(absent)


async def test_snapshot_media_externalization_roundtrip(
    store: PgStepStore, engine: AsyncEngine
) -> None:
    blob = bytes(range(256)) * 512  # 128 KiB，超过 64 KiB 阈值
    messages: list[ModelMessage] = [
        ModelRequest(
            parts=[
                UserPromptPart(
                    content=["look at this", BinaryContent(data=blob, media_type="image/png")]
                )
            ]
        ),
        ModelResponse(parts=[TextPart(content="seen")]),
    ]
    await store.save_snapshot(
        ContinuableSnapshot(run_id="r1", step_index=1, messages=messages, state="complete")
    )

    async with engine.connect() as conn:
        raw = (
            await conn.execute(text("SELECT messages FROM agent_runtime.snapshots"))
        ).scalar_one()
        media_rows = (
            await conn.execute(text("SELECT count(*) FROM agent_runtime.media"))
        ).scalar_one()
    assert "media+sha256://" in raw
    assert len(raw) < len(blob)
    assert media_rows == 1

    restored = await store.latest_snapshot(run_id="r1")
    assert restored is not None
    assert _dump(restored.messages) == _dump(messages)


async def test_agent_run_end_to_end_with_official_capability(store: PgStepStore) -> None:

    def model_logic(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(tool_name="lookup", args={"q": "iclip"})])
        return ModelResponse(parts=[TextPart(content="done")])

    agent = Agent(
        FunctionModel(model_logic),
        capabilities=[StepPersistence(store=store, agent_name="probe")],
    )

    @agent.tool_plain
    def lookup(q: str) -> str:
        return f"result for {q}"

    result = await agent.run("find iclip", conversation_id="conv-e2e")
    assert result.output == "done"

    runs = await store.list_runs(conversation_id="conv-e2e")
    assert len(runs) == 1
    run = runs[0]
    assert run.agent_name == "probe"
    # StepPersistence 将 agent_name 和 run_id 编码为不透明的 sp- 标识。
    assert run.run_id.startswith("sp-")
    assert run.registration_id is not None

    kinds = [e.kind for e in await store.list_events(run_id=run.run_id)]
    assert kinds[0] == "run_started"
    assert kinds[-1] == "run_completed"
    assert "tool_call_started" in kinds and "tool_call_completed" in kinds

    effects = await store.list_unresolved_tool_effects(run_id=run.run_id)
    assert effects == []

    history = await continue_run(store, run_id=run.run_id)
    assert json.loads(_dump(history)) == json.loads(_dump(result.all_messages()))
