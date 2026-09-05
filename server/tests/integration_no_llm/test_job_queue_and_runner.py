"""使用真实 PostgreSQL 与 FunctionModel 验证 prompt 队列、运行恢复及实时与历史 transcript 一致性。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from pydantic_ai import Tool
from pydantic_ai.messages import (
    INTERRUPTED_TOOL_RETURN_CONTENT,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import Conflict, NotFound
from iclip.harness.jobs import JobQueue, JobRow
from iclip.harness.transcript.activity import IDLE, ActivityState
from iclip.harness.transcript.from_messages import ORPHAN_TOOL_ERROR, run_ids_from_messages
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.service import TranscriptService
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.ops import (
    MAIN_AGENT_ID,
    TextContent,
    TranscriptTurn,
)
from tests.helpers.runtime import (
    AGENT_ID,
    DEAD,
    LOCKED_BY,
    MAX_CONTEXT_TOKENS,
    OWNER,
    approval_runner,
    awaits,
    build_runner,
    calls_tool,
    drained,
    expire_lease,
    first_run_messages,
    plant_interrupted,
    prompt_text,
    records_nothing,
    replay,
    says,
    submit_text,
    texts,
    tool_cards,
    waits,
    wrote,
)


def _waits_twice(
    entered: tuple[asyncio.Event, asyncio.Event], gates: tuple[asyncio.Event, asyncio.Event]
) -> FunctionModel:
    """分别阻塞两次请求；第二次等待使追加消息已被读取，再测试取消后的队列状态。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        index = min(asked, 1)
        asked += 1
        entered[index].set()
        await gates[index].wait()
        yield "第一句" if index == 0 else "第二句"

    return FunctionModel(stream_function=stream)


def _records(
    seen: list[list[ModelMessage]], entered: asyncio.Event, gate: asyncio.Event
) -> FunctionModel:
    """记录模型输入并阻塞首个请求；后续请求用于验证追加消息触发 redirect。"""

    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        seen.append(list(messages))
        if len(seen) == 1:
            entered.set()
            await gate.wait()
            yield "第一句"
        else:
            yield "补充收到了"

    return FunctionModel(stream_function=stream)


def _skeleton(turns: tuple[TranscriptTurn, ...]) -> list[Any]:
    """比较结构、id、正文、工具状态与轮错误，忽略时间戳。"""

    return [
        (
            turn.turn_id,
            turn.ordinal,
            turn.state,
            turn.content,
            turn.error,
            [
                (
                    step.step_id,
                    step.ordinal,
                    [
                        (
                            frame.frame_id,
                            frame.kind,
                            getattr(frame, "text", None),
                            getattr(frame, "state", None),
                        )
                        for frame in step.frames
                    ],
                )
                for step in turn.steps
            ],
        )
        for turn in turns
    ]


async def test_one_prompt_runs_and_lands_in_both_paths(engine: AsyncEngine) -> None:

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("好的，我来写"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "写三个镜头")
    await runner.shutdown()

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [turn.state for turn in derived] == ["completed"]
    assert prompt_text(derived[0]) == "写三个镜头"
    assert derived[0].steps[0].frames[0].text == "好的，我来写"  # pyright: ignore[reportAttributeAccessIssue]

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "completed"
    # 队列与消息使用同一 run_id，保证终态可直接关联。
    snapshot = await step_store.latest_conversation_snapshot(conversation_id=conversation_id)
    assert snapshot is not None
    assert run_ids_from_messages(snapshot.messages) == (row.run_id,)


async def test_second_prompt_queues_then_runs_after_the_first(engine: AsyncEngine) -> None:

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("第一句", "第二句"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "再做那个")

    queued = await queue.get(second)
    assert queued is not None
    assert queued.status == "queued"

    # 等待队列自然清空；shutdown 会取消刚启动的下一项。
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert (await queue.get(first)) is not None
    settled = await queue.get(second)
    assert settled is not None
    assert settled.run_id is not None

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [prompt_text(turn) for turn in derived] == ["先做这个", "再做那个"]
    assert [turn.ordinal for turn in derived] == [1, 2]


async def test_usage_is_filled_in_when_the_run_finishes(engine: AsyncEngine) -> None:

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("好"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "来")
    await runner.shutdown()

    turn = replay(store, conversation_id)[0]
    assert turn.usage is not None
    usage = turn.steps[0].usage
    assert usage is not None

    live_status = store.subscribe_view(conversation_id, MAIN_AGENT_ID).snapshot.meta.agent
    assert live_status is not None
    assert live_status.context_tokens == (
        usage.input_other + usage.output + usage.input_cache_read + usage.input_cache_creation
    )
    assert live_status.max_context_tokens == MAX_CONTEXT_TOKENS

    restored = await TranscriptService(
        store=TranscriptStore(),
        history=TranscriptHistory(step_store, queue),
        queue=queue,
        runner=runner,
        context_limits={AGENT_ID: MAX_CONTEXT_TOKENS},
        record_materials=records_nothing,
    ).page(conversation_id, runtime_agent_id=AGENT_ID)
    assert restored.meta.agent == live_status


async def test_sweep_settles_an_expired_lease_and_wakes_the_queue(engine: AsyncEngine) -> None:
    """租约过期且认领次数耗尽时终结任务并唤醒队列，避免会话永久阻塞。"""

    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, says("轮到我了"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    first = await queue.submit(
        prompt_id="prm_a",
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text="一"),),
        now=now,
        locked_by=DEAD,
    )
    second = await queue.submit(
        prompt_id="prm_b",
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text="二"),),
        now=now,
        locked_by=DEAD,
    )
    assert (first.status, second.status) == ("running", "queued")

    await expire_lease(engine, conversation_id, attempt=1)
    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    lost = await queue.get("prm_a")
    assert lost is not None
    assert lost.status == "failed"
    assert lost.interrupt_reason
    assert lost.locked_by is None

    woken = await queue.get("prm_b")
    assert woken is not None
    assert woken.status == "completed"
    assert woken.run_id is not None
    assert woken.locked_by == LOCKED_BY


async def test_an_interrupted_prompt_resumes_into_the_same_turn(engine: AsyncEngine) -> None:
    """续跑创建新 run，但须映射到原轮，保留已有输出且不重复用户消息。"""

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("接着写完了"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    first_run = f"{AGENT_ID}-dead"
    prompt_id = await plant_interrupted(
        engine,
        step_store,
        queue,
        conversation_id,
        run_id=first_run,
        messages=first_run_messages(first_run),
    )

    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "completed"
    assert row.attempt == 1
    assert row.run_id != first_run
    # run 到 prompt 的映射使多次运行归入同一轮。
    assert set(await queue.prompt_of_runs(conversation_id)) == {first_run, row.run_id}

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.state) for turn in derived] == [("t1", "completed")]
    steps = derived[0].steps
    assert [step.state for step in steps] == ["interrupted", "completed"]
    assert [frame for frame in steps[0].frames if getattr(frame, "role", None) == "user"] == []
    assert [getattr(frame, "text", None) for frame in steps[1].frames] == ["接着写完了"]

    replayed = replay(store, conversation_id)
    assert _skeleton(replayed) == _skeleton(derived)
    # 恢复时需标记旧 run 末步中断，保持实时与历史步骤状态一致。
    assert [step.state for step in replayed[0].steps] == ["interrupted", "completed"]


def _mid_tool_cycle_messages(run_id: str) -> list[ModelMessage]:
    """模拟两次工具调用中仅一次返回已持久化，末尾请求标记 interrupted。

    固定过去时间，确保续跑消息排在这段历史之后。
    """

    started = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
    return [
        ModelRequest(
            parts=[UserPromptPart(content="把这三个镜头出图")], run_id=run_id, timestamp=started
        ),
        ModelResponse(
            parts=[
                ToolCallPart(tool_name="draft", args="{}", tool_call_id="call_1"),
                ToolCallPart(tool_name="draft", args="{}", tool_call_id="call_2"),
            ],
            run_id=run_id,
            timestamp=started,
        ),
        ModelRequest(
            parts=[ToolReturnPart(tool_name="draft", content="出好了", tool_call_id="call_1")],
            run_id=run_id,
            timestamp=started,
            state="interrupted",
        ),
    ]


async def test_a_run_interrupted_mid_tool_cycle_is_repaired_by_the_official_path(
    engine: AsyncEngine,
) -> None:
    """框架补充未完成调用的 interrupted 返回后续跑，不新增用户消息。"""

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("剩下那张也出好了"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    first_run = f"{AGENT_ID}-dead"
    await plant_interrupted(
        engine,
        step_store,
        queue,
        conversation_id,
        run_id=first_run,
        messages=_mid_tool_cycle_messages(first_run),
    )

    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    snapshot = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert snapshot is not None
    returns = {
        part.tool_call_id: part
        for message in snapshot.messages
        for part in getattr(message, "parts", ())
        if isinstance(part, ToolReturnPart)
    }
    repaired = returns["call_2"]
    assert repaired.outcome == "interrupted"
    assert repaired.content == INTERRUPTED_TOOL_RETURN_CONTENT
    assert repaired.metadata  # 框架修复标记的键名由其私有模块定义。
    assert texts(list(snapshot.messages)) == ["把这三个镜头出图"]

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    cards = {card.tool_call_id: card for card in tool_cards(derived)}
    assert cards["call_1"].state == "done"
    # 修复返回在两条路上都按孤儿卡收尾，不透出框架的英文文案。
    assert (cards["call_2"].state, cards["call_2"].error) == ("error", ORPHAN_TOOL_ERROR)

    # 框架补偿返回不发事件，实时投影需显式结束对应工具卡。
    replayed = replay(store, conversation_id)
    live = {card.tool_call_id: card for card in tool_cards(replayed)}
    assert (live["call_2"].state, live["call_2"].error) == (
        "error",
        INTERRUPTED_TOOL_RETURN_CONTENT,
    )
    assert _skeleton(replayed) == _skeleton(derived)


async def test_a_run_interrupted_before_any_tool_return_re_executes_the_frontier(
    engine: AsyncEngine,
) -> None:
    """首个工具返回前中断会重新执行调用；结果须更新原卡，避免生成重复工具卡。"""

    ran = 0

    def draft() -> str:
        nonlocal ran
        ran += 1
        return "出好了"

    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine, says("三张都出好了"), store=store, tools=[draft]
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    first_run = f"{AGENT_ID}-dead"
    started = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
    prompt_id = await plant_interrupted(
        engine,
        step_store,
        queue,
        conversation_id,
        run_id=first_run,
        messages=[
            ModelRequest(
                parts=[UserPromptPart(content="把这三个镜头出图")],
                run_id=first_run,
                timestamp=started,
            ),
            ModelResponse(
                parts=[ToolCallPart(tool_name="draft", args="{}", tool_call_id="call_1")],
                run_id=first_run,
                timestamp=started,
            ),
        ],
    )

    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert (row.status, row.attempt) == ("completed", 1)
    assert ran == 1

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    card = tool_cards(derived)[0]
    assert (card.state, card.output) == ("done", "出好了")
    replayed = replay(store, conversation_id)
    live = tool_cards(replayed)[0]
    assert (live.state, live.output) == ("done", "出好了")
    assert _skeleton(replayed) == _skeleton(derived)


async def test_a_graceful_shutdown_releases_the_lease_for_a_later_resume(
    engine: AsyncEngine,
) -> None:
    """优雅关停释放租约但不判失败，保留持久化进度供下一进程续跑。"""

    entered = (asyncio.Event(), asyncio.Event())
    gates = (asyncio.Event(), asyncio.Event())
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, _waits_twice(entered, gates), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered[0].wait()
    await runner.steer(conversation_id, (second,))
    gates[0].set()
    await entered[1].wait()

    await runner.shutdown()

    released = await queue.get(first)
    assert released is not None
    assert released.status == "running"
    assert released.locked_by is None
    assert released.interrupt_reason
    appended = await queue.get(second)
    assert appended is not None
    assert appended.status == "steered"

    store2 = TranscriptStore()
    runner2, _step_store2, queue2 = build_runner(engine, says("接着写完了"), store=store2)
    await runner2.sweep_once()
    await drained(queue2, conversation_id)
    await runner2.shutdown()

    resumed = await queue.get(first)
    assert resumed is not None
    assert resumed.status == "completed"
    assert resumed.attempt == 1
    # 已读取的追加消息改属续跑 run，终态随新运行更新。
    settled = await queue.get(second)
    assert settled is not None
    assert settled.status == "completed"
    assert settled.run_id == resumed.run_id


async def test_sweep_does_not_claim_a_row_this_process_is_still_running(
    engine: AsyncEngine,
) -> None:
    """事件循环阻塞可能使本进程心跳过期；清扫不得重复认领仍在执行的任务。"""

    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "先做这个")
    await entered.wait()
    await expire_lease(engine, conversation_id)

    await runner.sweep_once()

    stale = await queue.get(prompt_id)
    assert stale is not None
    assert stale.attempt == 0
    assert stale.locked_by == LOCKED_BY

    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert [prompt_text(turn) for turn in replay(store, conversation_id)] == ["先做这个"]


async def test_a_prompt_that_used_up_its_attempts_is_failed(engine: AsyncEngine) -> None:
    """认领次数耗尽时任务及已递交的追加消息均应失败。"""

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("不该跑到我"), store=store)
    for attempt in (1, 2):
        conversation_id = f"c-{uuid.uuid4().hex[:8]}"
        run_id = f"{AGENT_ID}-dead-{attempt}"
        prompt_id = await plant_interrupted(
            engine,
            step_store,
            queue,
            conversation_id,
            run_id=run_id,
            messages=first_run_messages(run_id),
            attempt=attempt,
        )
        appended = await submit_text(runner, queue, conversation_id, "临时插一句")
        await queue.mark_steered((appended,), run_id=run_id, now=datetime.now(UTC))

        await runner.sweep_once()

        row = await queue.get(prompt_id)
        assert row is not None
        assert row.status == "failed"
        assert row.interrupt_reason
        assert row.locked_by is None
        assert row.attempt == attempt
        child = await queue.get(appended)
        assert child is not None
        assert child.status == "failed"
    await runner.shutdown()


async def test_a_prompt_interrupted_before_its_first_snapshot_runs_again(
    engine: AsyncEngine,
) -> None:
    """首个快照前中断没有用户历史，必须按原 prompt 重跑，不能走不添加消息的续跑流程。"""

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("这次跑完了"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    prompt_id = await plant_interrupted(
        engine, step_store, queue, conversation_id, run_id=f"{AGENT_ID}-dead"
    )

    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "completed"
    assert row.attempt == 1

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.ordinal, prompt_text(turn)) for turn in derived] == [
        ("t1", 1, "把这三个镜头出图")
    ]
    assert _skeleton(replay(store, conversation_id)) == _skeleton(derived)


async def test_a_live_lease_is_left_alone(engine: AsyncEngine) -> None:

    runner, _step_store, queue = build_runner(engine, says("好"), store=TranscriptStore())
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    await queue.submit(
        prompt_id="prm_live",
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text="别人在跑"),),
        now=datetime.now(UTC),
        locked_by="w-other",
    )

    await runner.sweep_once()
    await runner.shutdown()

    row = await queue.get("prm_live")
    assert row is not None
    assert row.status == "running"
    assert row.locked_by == "w-other"


async def test_a_queued_prompt_survives_a_restart_and_gets_picked_up(
    engine: AsyncEngine,
) -> None:

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for prompt_id, said in (("prm_head", "先做这个"), ("prm_tail", "再做那个")):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text=said),),
            now=now,
            locked_by=DEAD,
        )
    # 模拟前一运行已收尾、进程在唤醒下一任务前退出。
    await queue.finish("prm_head", status="completed", now=now, locked_by=DEAD, attempt=0)

    runner, _step_store, _queue = build_runner(engine, says("轮到我了"), store=TranscriptStore())
    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    tail = await queue.get("prm_tail")
    assert tail is not None
    assert tail.status == "completed"
    assert tail.locked_by == LOCKED_BY


async def test_a_run_whose_lease_was_taken_cancels_itself(engine: AsyncEngine) -> None:
    """租约转移后旧进程必须取消运行并停止写入，避免两个进程同时推进会话。"""

    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "先做这个")
    await entered.wait()

    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE agent_runtime.agent_jobs SET locked_by = 'w-other' WHERE prompt_id = :id"),
            {"id": prompt_id},
        )
    await runner.heartbeat_once()
    gate.set()  # 释放模型请求，使运行可处理取消。
    await runner.shutdown()

    assert [turn.state for turn in replay(store, conversation_id)] == ["cancelled"]

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "running"
    assert row.locked_by == "w-other"
    assert row.finished_at is None


async def test_only_the_running_row_carries_a_lease(engine: AsyncEngine) -> None:

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    rows = [
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text=said),),
            now=now,
            locked_by=LOCKED_BY,
        )
        for prompt_id, said in (("prm_head", "先做这个"), ("prm_tail", "再做那个"))
    ]
    head, tail = rows
    assert head.locked_by == LOCKED_BY
    assert head.heartbeat_at is not None
    assert (tail.locked_by, tail.heartbeat_at) == (None, None)

    await queue.finish("prm_head", status="completed", now=now, locked_by=LOCKED_BY, attempt=0)
    started = await queue.start_next(conversation_id, locked_by="w-next")
    assert started is not None
    assert started.locked_by == "w-next"
    assert started.heartbeat_at is not None


async def test_attach_run_maps_every_run_to_its_prompt(engine: AsyncEngine) -> None:
    """按会话加载 run 到 prompt 的映射，避免跨会话错误合轮。"""

    queue = JobQueue(engine)
    now = datetime.now(UTC)
    for prompt_id, conversation_id in (("prm_mine", "c-mine"), ("prm_yours", "c-yours")):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text="走"),),
            now=now,
            locked_by=LOCKED_BY,
        )
    await queue.attach_run("prm_mine", "r-first", locked_by=LOCKED_BY, attempt=0)
    await queue.attach_run("prm_mine", "r-second", locked_by=LOCKED_BY, attempt=0)
    await queue.attach_run("prm_yours", "r-other", locked_by=LOCKED_BY, attempt=0)

    assert await queue.prompt_of_runs("c-mine") == {
        "r-first": "prm_mine",
        "r-second": "prm_mine",
    }
    assert await queue.prompt_of_runs("c-yours") == {"r-other": "prm_yours"}

    first = await queue.get_by_run("r-first")
    second = await queue.get_by_run("r-second")
    assert first is not None
    assert second is not None
    assert (first.prompt_id, second.prompt_id) == ("prm_mine", "prm_mine")
    assert second.run_id == "r-second"


async def test_attach_run_writes_nothing_when_the_lease_moved_on(engine: AsyncEngine) -> None:
    """失租后 attach_run 既不能更新任务，也不能写 run 映射，避免污染轮归属。"""

    queue = JobQueue(engine)
    await queue.submit(
        prompt_id="prm_fenced",
        conversation_id="c-fenced",
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text="走"),),
        now=datetime.now(UTC),
        locked_by=LOCKED_BY,
    )

    await queue.attach_run("prm_fenced", "r-stale", locked_by="w-other", attempt=0)

    row = await queue.get("prm_fenced")
    assert row is not None
    assert row.run_id is None
    assert await queue.prompt_of_runs("c-fenced") == {}
    assert (await queue.get_by_run("r-stale")) is None


async def test_resubmitting_the_same_prompt_id_does_not_start_a_second_run(
    engine: AsyncEngine,
) -> None:

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for _ in range(2):
        await queue.submit(
            prompt_id="prm_same",
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text="一"),),
            now=now,
            locked_by=LOCKED_BY,
        )
    view = await queue.view(conversation_id)
    assert view.active is not None
    assert view.queued == ()


async def test_the_same_prompt_id_in_another_conversation_is_rejected(
    engine: AsyncEngine,
) -> None:
    """prompt id 由客户端生成；重复 id 须检查会话归属，防止返回其他用户的记录。"""

    queue = JobQueue(engine)
    now = datetime.now(UTC)
    await queue.submit(
        prompt_id="prm_shared",
        conversation_id="c-mine",
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text="我的"),),
        now=now,
        locked_by=LOCKED_BY,
    )
    with pytest.raises(Conflict):
        await queue.submit(
            prompt_id="prm_shared",
            conversation_id="c-yours",
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text="你的"),),
            now=now,
            locked_by=LOCKED_BY,
        )


async def test_the_same_prompt_id_submitted_twice_at_once_lands_as_one_row(
    engine: AsyncEngine,
) -> None:
    """重复请求预查与插入之间无锁，并发请求需通过主键冲突路径返回同一任务。"""

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)

    async def once() -> JobRow:
        return await queue.submit(
            prompt_id="prm_doubled",
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text="一"),),
            now=now,
            locked_by=LOCKED_BY,
        )

    first, second = await asyncio.gather(once(), once())

    assert (first.prompt_id, second.prompt_id) == ("prm_doubled", "prm_doubled")
    view = await queue.view(conversation_id)
    assert view.active is not None
    assert view.queued == ()


async def test_a_write_from_an_older_attempt_changes_nothing(engine: AsyncEngine) -> None:
    """同一进程重新认领时 locked_by 不变，须以 attempt 区分新旧运行并拒绝旧写入。"""

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    await queue.submit(
        prompt_id="prm_fenced_attempt",
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text="走"),),
        now=now,
        locked_by=LOCKED_BY,
    )
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE agent_runtime.agent_jobs SET attempt = 1 "
                "WHERE prompt_id = 'prm_fenced_attempt'"
            )
        )

    await queue.finish(
        "prm_fenced_attempt", status="completed", now=now, locked_by=LOCKED_BY, attempt=0
    )
    stale = await queue.get("prm_fenced_attempt")
    assert stale is not None
    assert stale.status == "running"

    await queue.finish(
        "prm_fenced_attempt", status="completed", now=now, locked_by=LOCKED_BY, attempt=1
    )
    settled = await queue.get("prm_fenced_attempt")
    assert settled is not None
    assert settled.status == "completed"


async def test_a_message_withdrawn_while_queued_is_not_the_last_turn_reason(
    engine: AsyncEngine,
) -> None:
    """排队后撤销的消息未执行，其较晚 finished_at 不应覆盖最近实际运行的结果。"""

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for prompt_id, said in (("prm_ran", "先做这个"), ("prm_withdrawn", "再做那个")):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text=said),),
            now=now,
            locked_by=LOCKED_BY,
        )
    await queue.finish("prm_ran", status="completed", now=now, locked_by=LOCKED_BY, attempt=0)
    await queue.abort(
        "prm_withdrawn", conversation_id=conversation_id, now=now + timedelta(minutes=1)
    )

    assert await queue.activities((conversation_id,)) == {
        conversation_id: ActivityState(busy=False, last_turn_reason="completed")
    }


async def test_an_append_riding_the_turn_does_not_hide_the_approval(
    engine: AsyncEngine,
) -> None:

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for prompt_id, said in (("prm_parked", "改这个文件"), ("prm_appended", "顺便还有")):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text=said),),
            now=now,
            locked_by=LOCKED_BY,
        )
    run_id = f"{AGENT_ID}-parked"
    await queue.attach_run("prm_parked", run_id, locked_by=LOCKED_BY, attempt=0)
    assert (await queue.await_approvals("prm_parked", locked_by=LOCKED_BY, attempt=0)) is not None
    await queue.mark_steered(("prm_appended",), run_id=run_id, now=now)

    assert await queue.activities((conversation_id,)) == {
        conversation_id: ActivityState(busy=True, pending_interaction="approval")
    }


async def test_conversations_split_into_running_and_done(engine: AsyncEngine) -> None:

    queue = JobQueue(engine)
    now = datetime.now(UTC)
    running_id = f"c-{uuid.uuid4().hex[:8]}"
    done_id = f"c-{uuid.uuid4().hex[:8]}"
    untouched_id = f"c-{uuid.uuid4().hex[:8]}"
    for prompt_id, conversation_id in (("prm_a", running_id), ("prm_b", done_id)):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text="走"),),
            now=now,
            locked_by=LOCKED_BY,
        )
    await queue.finish("prm_b", status="completed", now=now, locked_by=LOCKED_BY, attempt=0)

    assert await queue.conversation_ids(OWNER, "running") == frozenset({running_id})
    assert await queue.conversation_ids(OWNER, "done") == frozenset({done_id})
    assert await queue.conversation_ids(uuid.uuid4(), "running") == frozenset()
    assert await queue.activities((untouched_id,)) == {untouched_id: IDLE}


async def test_aborting_the_conversation_leaves_nothing_queued_to_pick_up(
    engine: AsyncEngine,
) -> None:
    """停止会话须先清空队列，避免取消当前运行后的收尾逻辑启动队首。"""

    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "再做那个")
    third = await submit_text(runner, queue, conversation_id, "还有这个")
    await entered.wait()

    await runner.abort_conversation(conversation_id)
    gate.set()  # 释放模型请求，使运行可处理取消。
    await drained(queue, conversation_id)
    await runner.shutdown()

    for prompt_id in (second, third):
        row = await queue.get(prompt_id)
        assert row is not None
        assert row.status == "aborted"
        assert row.run_id is None

    assert [prompt_text(turn) for turn in replay(store, conversation_id)] == ["先做这个"]


async def test_aborting_a_queued_prompt_marks_it_aborted(engine: AsyncEngine) -> None:
    """排队任务无租约，撤销应使用不要求租约的状态更新路径。"""

    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "再做那个")
    await entered.wait()

    await runner.abort(conversation_id, second)
    row = await queue.get(second)
    assert row is not None
    assert row.status == "aborted"

    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()


async def test_an_append_landing_after_the_last_model_request_still_reaches_the_model(
    engine: AsyncEngine,
) -> None:
    """末次请求期间到达的追加消息须立即交给框架，才能在运行结束前触发 redirect。"""

    seen: list[list[ModelMessage]] = []
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, _records(seen, entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()

    await runner.steer(conversation_id, (second,))
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert len(seen) == 2
    assert "临时插一句" in texts(seen[1])

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [prompt_text(turn) for turn in derived] == ["先做这个"]
    assert "临时插一句" in [
        getattr(frame, "text", None)
        for turn in derived
        for step in turn.steps
        for frame in step.frames
    ]

    started = await queue.get(first)
    appended = await queue.get(second)
    assert started is not None
    assert appended is not None
    assert appended.run_id == started.run_id
    assert appended.status == "completed"
    assert appended.steered_at is not None


async def test_an_append_is_cancelled_with_the_turn_instead_of_starting_a_new_one(
    engine: AsyncEngine,
) -> None:
    """已读取追加消息随当前轮取消，不可重新排队，否则停止后会启动新轮。"""

    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()

    await runner.steer(conversation_id, (second,))
    await runner.abort_conversation(conversation_id)
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    appended = await queue.get(second)
    assert appended is not None
    assert appended.status == "aborted"

    assert [prompt_text(turn) for turn in replay(store, conversation_id)] == ["先做这个"]


async def test_an_append_the_run_never_read_goes_back_to_the_queue(engine: AsyncEngine) -> None:
    """直接验证标记 steered 与退回 queued 的状态转换，覆盖结束竞态中的未读消息回收。"""

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for prompt_id, said in (("prm_head", "先做这个"), ("prm_tail", "临时插一句")):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text=said),),
            now=now,
            locked_by=LOCKED_BY,
        )

    (moved,) = await queue.mark_steered(("prm_tail",), run_id=f"{AGENT_ID}-dead", now=now)
    assert moved.status == "steered"
    assert moved.run_id == f"{AGENT_ID}-dead"
    # 对外协议不含 steered，需映射为已定义状态。
    assert moved.as_entity().status == "running"
    assert (await queue.view(conversation_id)).queued == ()

    (back,) = await queue.requeue_steered(("prm_tail",))
    assert back.status == "queued"
    assert back.run_id is None
    assert back.steered_at is None
    assert [row.prompt_id for row in (await queue.view(conversation_id)).queued] == ["prm_tail"]


async def test_sweep_settles_an_append_that_rode_a_lost_run(engine: AsyncEngine) -> None:

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for prompt_id, said in (("prm_running", "先做这个"), ("prm_appended", "临时插一句")):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text=said),),
            now=now,
            locked_by=DEAD,
        )
    run_id = f"{AGENT_ID}-dead"
    await queue.attach_run("prm_running", run_id, locked_by=DEAD, attempt=0)
    await queue.mark_steered(("prm_appended",), run_id=run_id, now=now)

    await expire_lease(engine, conversation_id, attempt=1)
    runner, _step_store, _queue = build_runner(engine, says("好"), store=TranscriptStore())
    await runner.sweep_once()
    await runner.shutdown()

    appended = await queue.get("prm_appended")
    assert appended is not None
    assert appended.status == "failed"


async def test_appending_when_nothing_is_running_is_a_conflict(engine: AsyncEngine) -> None:

    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, says("好"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "先做这个")
    await drained(queue, conversation_id)
    await runner.shutdown()

    with pytest.raises(Conflict):
        await runner.steer(conversation_id, (prompt_id,))


async def test_a_run_that_died_mid_tool_still_shows_up_after_a_refresh(
    engine: AsyncEngine,
) -> None:
    """历史展示须读取 interrupted 快照；仅使用恢复执行的完整快照读取规则会丢失失败轮。"""

    def boom() -> str:
        raise RuntimeError("工具炸了")

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, calls_tool("boom"), store=store, tools=[boom])
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这三个镜头重新出图")
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "failed"

    assert (await step_store.latest_conversation_snapshot(conversation_id=conversation_id)) is None
    interrupted = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert interrupted is not None

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [prompt_text(turn) for turn in derived] == ["把这三个镜头重新出图"]
    assert [turn.state for turn in derived] == ["failed"]

    tools = [
        frame
        for turn in derived
        for step in turn.steps
        for frame in step.frames
        if frame.kind == "tool"
    ]
    assert [frame.state for frame in tools] == ["error"]

    assert _skeleton(derived) == _skeleton(replay(store, conversation_id))


async def test_the_close_out_result_tells_the_model_the_call_failed(
    engine: AsyncEngine,
) -> None:
    """悬空调用的补偿结果必须显式标记失败；裸字符串会被框架包装为成功 ToolReturn。"""

    def boom() -> str:
        raise RuntimeError("工具炸了")

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, calls_tool("boom"), store=store, tools=[boom])
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    await drained(queue, conversation_id)

    store2 = TranscriptStore()
    runner2, _step_store2, queue2 = build_runner(engine, says("好"), store=store2)
    await submit_text(runner2, queue2, conversation_id, "再做那个")
    await drained(queue2, conversation_id)
    await runner.shutdown()
    await runner2.shutdown()

    snapshot = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert snapshot is not None
    returns = [
        part
        for message in snapshot.messages
        for part in getattr(message, "parts", ())
        if isinstance(part, ToolReturnPart)
    ]
    assert [part.outcome for part in returns] == ["failed"]
    assert [part.content for part in returns] == [INTERRUPTED_TOOL_RETURN_CONTENT]


async def test_the_next_turn_after_a_failed_one_does_not_reuse_its_ordinal(
    engine: AsyncEngine,
) -> None:
    """中断快照也占用轮号；下一运行必须递增，避免实时轮覆盖历史失败轮。"""

    def boom() -> str:
        raise RuntimeError("工具炸了")

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, calls_tool("boom"), store=store, tools=[boom])
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    await drained(queue, conversation_id)

    # 使用同一 runner 和正常模型创建下一轮。
    store2 = TranscriptStore()
    runner2, _step_store2, queue2 = build_runner(engine, says("好"), store=store2)
    await submit_text(runner2, queue2, conversation_id, "再做那个")
    await drained(queue2, conversation_id)
    await runner.shutdown()
    await runner2.shutdown()

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.ordinal) for turn in derived] == [("t1", 1), ("t2", 2)]
    assert [turn.state for turn in derived] == ["failed", "completed"]


async def test_shutdown_puts_an_append_the_run_never_read_back_in_the_queue(
    engine: AsyncEngine,
) -> None:
    """关停时框架尚未读取的追加消息须退回 queued，避免被续跑误标为已完成。"""

    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()

    await runner.steer(conversation_id, (second,))
    # 保持 gate 关闭，使取消发生在请求内部，追加消息仍未被读取。
    await runner.shutdown()

    appended = await queue.get(second)
    assert appended is not None
    assert appended.status == "queued"
    assert appended.run_id is None


async def test_aborting_a_prompt_from_another_conversation_is_not_found(
    engine: AsyncEngine,
) -> None:

    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, says("好"), store=store)
    prompt_id = await submit_text(runner, queue, "c-owner", "跑起来")
    second = await submit_text(runner, queue, "c-owner", "排着")

    for target in (prompt_id, second):
        with pytest.raises(NotFound):
            await runner.abort("c-someone-else", target)
    queued = await queue.get(second)
    assert queued is not None
    assert queued.status == "queued"

    await runner.shutdown()


def _waits_then_calls(name: str, entered: asyncio.Event, gate: asyncio.Event) -> FunctionModel:
    """阻塞首次响应供追加消息进入 run，再触发待审批工具调用。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            entered.set()
            await gate.wait()
            yield {0: DeltaToolCall(name=name, json_args="{}", tool_call_id="call_1")}
        else:
            yield "改完了"

    return FunctionModel(stream_function=stream)


async def test_an_append_arriving_as_the_run_would_park_on_approval_is_not_lost(
    engine: AsyncEngine,
) -> None:
    """追加消息可使待审批运行转为正常结束，但末尾仍有无返回调用。

    StepPersistence 不保存该形状，运行层须补存快照，避免历史和轮号丢失。
    """

    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        _waits_then_calls("write_file", entered, gate),
        store=store,
        tools=[Tool(wrote, name="write_file", requires_approval=True)],
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()
    await runner.steer(conversation_id, (second,))
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    settled = await queue.get(first)
    appended = await queue.get(second)
    assert settled is not None
    assert appended is not None
    assert settled.status == "completed"
    assert (appended.status, appended.run_id) == ("completed", settled.run_id)

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.state, prompt_text(turn)) for turn in derived] == [
        ("t1", "completed", "把这个文件改掉")
    ]
    snapshot = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert snapshot is not None
    assert "临时插一句" in texts(list(snapshot.messages))
    assert [card.state for card in tool_cards(derived)] == ["error"]
    assert _skeleton(replay(store, conversation_id)) == _skeleton(derived)


async def test_a_tool_needing_approval_ends_the_run_and_parks_the_prompt(
    engine: AsyncEngine,
) -> None:
    """待审批时结束 run 并持久化等待状态，不能将可能持续数天的等待保留在进程内。"""

    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    row = await awaits(queue, prompt_id)

    assert row.as_entity().status == "running"
    assert (row.locked_by, row.heartbeat_at) == (None, None)
    assert row.run_id is not None

    # 框架不持久化含开放调用的快照，此时由运行层保存。
    assert (await step_store.latest_conversation_snapshot(conversation_id=conversation_id)) is None
    parked = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert parked is not None
    assert run_ids_from_messages(parked.messages) == (row.run_id,)

    live = replay(store, conversation_id)
    assert [turn.state for turn in live] == ["running"]
    assert [step.state for step in live[0].steps] == ["completed"]
    card = tool_cards(live)[0]
    assert (card.state, card.approval_id) == ("running", "apr_call_1")
    assert [
        item.interaction_id for item in store.pending_interactions(conversation_id, MAIN_AGENT_ID)
    ] == ["apr_call_1"]

    # 使用空实时 store 模拟重启，验证待审批状态可从数据库恢复。
    page = await TranscriptService(
        store=TranscriptStore(),
        history=TranscriptHistory(step_store, queue),
        queue=queue,
        runner=runner,
        context_limits={AGENT_ID: MAX_CONTEXT_TOKENS},
        record_materials=records_nothing,
    ).page(conversation_id, runtime_agent_id=AGENT_ID)
    assert [turn.state for turn in page.items] == ["running"]
    restored = tool_cards(page.items)[0]
    assert (restored.state, restored.approval_id) == ("running", "apr_call_1")
    assert page.pending_interactions == ("apr_call_1",)
    assert page.meta.activity == "turn"

    assert await queue.activities((conversation_id,)) == {
        conversation_id: ActivityState(busy=True, pending_interaction="approval")
    }

    await runner.shutdown()


async def test_approving_resumes_the_same_turn(engine: AsyncEngine) -> None:
    """审批续跑保持同一轮且不增加 attempt；该计数仅表示中断后的重新认领。"""

    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    await awaits(queue, prompt_id)
    await runner.approve(conversation_id, "apr_call_1", approved=True)
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert (row.status, row.attempt) == ("completed", 0)
    assert row.decisions == {"call_1": True}
    assert len(await queue.prompt_of_runs(conversation_id)) == 2

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.state) for turn in derived] == [("t1", "completed")]
    card = tool_cards(derived)[0]
    assert (card.state, card.approval_id) == ("done", "apr_call_1")
    assert [item.state for item in derived[0].steps] == ["completed", "completed"]
    assert [getattr(frame, "text", None) for frame in derived[0].steps[1].frames] == ["改完了"]
    assert [
        item.state
        for item in (await TranscriptHistory(step_store, queue).read(conversation_id)).interactions
    ] == ["approved"]

    assert _skeleton(replay(store, conversation_id)) == _skeleton(derived)


async def test_rejecting_settles_the_card_as_an_error_and_the_model_moves_on(
    engine: AsyncEngine,
) -> None:

    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store, reply="那我不动它")
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    await awaits(queue, prompt_id)
    await runner.approve(conversation_id, "apr_call_1", approved=False)
    await drained(queue, conversation_id)
    await runner.shutdown()

    history = await TranscriptHistory(step_store, queue).read(conversation_id)
    assert [turn.state for turn in history.turns] == ["completed"]
    card = tool_cards(history.turns)[0]
    assert (card.state, card.approval_id) == ("error", "apr_call_1")
    assert [item.state for item in history.interactions] == ["rejected"]
    assert [getattr(frame, "text", None) for frame in history.turns[0].steps[1].frames] == [
        "那我不动它"
    ]
    assert _skeleton(replay(store, conversation_id)) == _skeleton(history.turns)


async def test_the_run_resumes_only_once_every_approval_is_answered(
    engine: AsyncEngine,
) -> None:
    """框架要求全部待审批调用都有决定，仅在结果齐全后续跑。"""

    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store, calls=2)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这两个文件改掉")
    await awaits(queue, prompt_id)

    await runner.approve(conversation_id, "apr_call_1", approved=True)
    half = await queue.get(prompt_id)
    assert half is not None
    assert (half.status, half.decisions) == ("awaiting", {"call_1": True})

    # 同一决定幂等，冲突决定须拒绝，因为工具可能已按原决定执行。
    await runner.approve(conversation_id, "apr_call_1", approved=True)
    with pytest.raises(Conflict):
        await runner.approve(conversation_id, "apr_call_1", approved=False)
    # 未知调用 id 不能产生审批记录。
    with pytest.raises(NotFound):
        await runner.approve(conversation_id, "apr_nobody", approved=True)

    await runner.approve(conversation_id, "apr_call_2", approved=True)
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert (row.status, row.decisions) == ("completed", {"call_1": True, "call_2": True})
    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [card.state for card in tool_cards(derived)] == ["done", "done"]
    assert _skeleton(replay(store, conversation_id)) == _skeleton(derived)


async def test_a_conversation_waiting_for_approval_takes_no_steering_and_queues_the_next(
    engine: AsyncEngine,
) -> None:
    """待审批时新消息排队；撤销需清理实时交互和工具卡，再推进队列。"""

    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    await awaits(queue, first)
    second = await submit_text(runner, queue, conversation_id, "再说点别的")

    queued = await queue.get(second)
    assert queued is not None
    assert queued.status == "queued"
    with pytest.raises(Conflict):
        await runner.steer(conversation_id, (second,))

    await runner.abort(conversation_id, first)
    aborted = await queue.get(first)
    assert aborted is not None
    assert aborted.status == "aborted"

    await drained(queue, conversation_id)
    await runner.shutdown()

    replayed = replay(store, conversation_id)
    assert replayed[0].state == "cancelled"
    assert [card.state for card in tool_cards(replayed[:1])] == ["error"]
    assert store.pending_interactions(conversation_id, MAIN_AGENT_ID) == ()

    following = await queue.get(second)
    assert following is not None
    assert following.status == "completed"
    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.state) for turn in derived] == [
        ("t1", "cancelled"),
        ("t2", "completed"),
    ]


async def test_stopping_the_conversation_also_drops_the_one_waiting_for_approval(
    engine: AsyncEngine,
) -> None:
    """停止会话须处理无活动 run 的待审批任务，并取消其 steered 消息，避免永久占用。"""

    store = TranscriptStore()
    runner, _step_store, queue = approval_runner(engine, store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    parked = await awaits(queue, prompt_id)
    # 模拟已递交、等待审批续跑处理的 steered 消息。
    appended = await submit_text(runner, queue, conversation_id, "临时插一句")
    assert parked.run_id is not None
    await queue.mark_steered((appended,), run_id=parked.run_id, now=datetime.now(UTC))

    await runner.abort_conversation(conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "aborted"
    child = await queue.get(appended)
    assert child is not None
    assert child.status == "aborted"
    assert [turn.state for turn in replay(store, conversation_id)] == ["cancelled"]
