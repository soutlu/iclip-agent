"""prompt 队列与运行驱动的全链路验收（真实 Postgres + FunctionModel）。

单测那几条是手工把事件喂给投影器的，盖不住这几段接线：``run_stream_events`` 的对接、两套
run id 合一之后终态查得出来、一轮跑完接上排队的下一条、实时那份与刷新之后现推的那份一致。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator, AsyncIterator
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, DeltaToolCalls, FunctionModel
from pydantic_ai_harness.step_persistence import StepPersistence
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.common.errors import Conflict, NotFound
from iclip.harness.prompts import PromptQueue
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.transcript.from_messages import run_ids_from_messages
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.ops import MAIN_AGENT_ID, TextContent, TranscriptTurn

AGENT_ID = "storyboard"
OWNER = uuid.UUID("11111111-2222-3333-4444-555555555555")


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "TRUNCATE agent_runtime.runs, agent_runtime.events, agent_runtime.snapshots, "
                "agent_runtime.tool_effects, agent_runtime.media, agent_runtime.prompts"
            )
        )
    try:
        yield engine
    finally:
        await engine.dispose()


def _says(*replies: str) -> FunctionModel:
    """每次被问就照顺序回一句。"""

    said = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal said
        yield replies[min(said, len(replies) - 1)]
        said += 1

    return FunctionModel(stream_function=stream)


def _runner(
    engine: AsyncEngine, model: FunctionModel, *, store: TranscriptStore
) -> tuple[ConversationRunner, PgStepStore, PromptQueue]:
    step_store = PgStepStore(engine)
    agent = Agent(
        model,
        name=AGENT_ID,
        # 顶层不设 agent_name：run id 要用我们传进去的那个，见 harness.agents._load_agent。
        capabilities=[StepPersistence(store=step_store)],
    )
    queue = PromptQueue(engine)

    async def deps_for(_row: Any) -> object:
        return None

    runner = ConversationRunner(
        agents={AGENT_ID: agent},
        store=store,
        queue=queue,
        snapshots=step_store,
        deps_for=deps_for,
    )
    return runner, step_store, queue


async def _submit(
    runner: ConversationRunner, queue: PromptQueue, conversation_id: str, text_: str
) -> str:
    prompt_id = f"prm_{uuid.uuid4().hex[:8]}"
    row = await queue.submit(
        prompt_id=prompt_id,
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text=text_),),
        now=datetime.now(UTC),
    )
    await runner.submit(row)
    return prompt_id


async def _drained(queue: PromptQueue, conversation_id: str, *, tries: int = 200) -> None:
    """等到这段对话既没有在跑的也没有排队的。"""

    for _ in range(tries):
        view = await queue.view(conversation_id)
        if view.active is None and not view.queued:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("队列没排空")


def _replay(store: TranscriptStore, conversation_id: str) -> tuple[TranscriptTurn, ...]:
    """把订阅者收到的那些操作重放一遍，得到他屏幕上的那一份。

    不直接读 ``live_turns``：一轮落进消息历史之后就从实时状态里交接走了，那时它已经空了。
    要比的本来也是**客户端收到的东西**，重放才是它。
    """

    replayed = TranscriptStore()
    for batch in store.subscribe_view(conversation_id, MAIN_AGENT_ID, since=0).batches:
        replayed.append(conversation_id, MAIN_AGENT_ID, batch.ops)
    return replayed.subscribe_view(conversation_id, MAIN_AGENT_ID).live_turns


def _skeleton(turns: tuple[TranscriptTurn, ...]) -> list[Any]:
    """比结构、比 id、比正文，不比时刻。"""

    return [
        (
            turn.turn_id,
            turn.ordinal,
            turn.state,
            turn.prompt,
            [
                (
                    step.step_id,
                    step.ordinal,
                    [
                        (frame.frame_id, frame.kind, getattr(frame, "text", None))
                        for frame in step.frames
                    ],
                )
                for step in turn.steps
            ],
        )
        for turn in turns
    ]


async def test_one_prompt_runs_and_lands_in_both_paths(engine: AsyncEngine) -> None:
    """跑一轮：实时那份与刷新之后现推的那份，结构逐字相同，终态都读得出「跑完了」。"""

    store = TranscriptStore()
    runner, step_store, queue = _runner(engine, _says("好的，我来写"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await _submit(runner, queue, conversation_id, "写三个镜头")
    await runner.shutdown()

    derived = await TranscriptHistory(step_store).turns(conversation_id)
    assert [turn.state for turn in derived] == ["completed"]
    assert derived[0].prompt == "写三个镜头"
    assert derived[0].steps[0].frames[0].text == "好的，我来写"  # pyright: ignore[reportAttributeAccessIssue]

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "completed"
    # 队列记下的 run id 就是消息上盖的那个：终态因此按 run_id 直接查得到，不必按时序对齐。
    snapshot = await step_store.latest_conversation_snapshot(conversation_id=conversation_id)
    assert snapshot is not None
    assert run_ids_from_messages(snapshot.messages) == (row.run_id,)


async def test_live_projection_matches_the_derived_one(engine: AsyncEngine) -> None:
    """同一轮，跑的时候看到的与刷新之后看到的必须是同一份。"""

    store = TranscriptStore()
    runner, step_store, queue = _runner(engine, _says("在写了"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await _submit(runner, queue, conversation_id, "开始")
    await runner.shutdown()

    derived = await TranscriptHistory(step_store).turns(conversation_id)
    assert _skeleton(_replay(store, conversation_id)) == _skeleton(derived)


async def test_second_prompt_queues_then_runs_after_the_first(engine: AsyncEngine) -> None:
    """一段对话同时只跑一条：第二条排队，第一条跑完自动接上。"""

    store = TranscriptStore()
    runner, step_store, queue = _runner(engine, _says("第一句", "第二句"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await _submit(runner, queue, conversation_id, "先做这个")
    second = await _submit(runner, queue, conversation_id, "再做那个")

    queued = await queue.get(second)
    assert queued is not None
    assert queued.status == "queued"  # 第一条还在跑，这条只能排着

    # 等排空器自己把队列清干净。不能拿 shutdown 代替：那是「立刻停下」，会把刚接上的那条取消掉。
    await _drained(queue, conversation_id)
    await runner.shutdown()

    assert (await queue.get(first)) is not None
    settled = await queue.get(second)
    assert settled is not None
    assert settled.run_id is not None  # 它自己起过一次 run，不是被顺手标掉的

    derived = await TranscriptHistory(step_store).turns(conversation_id)
    assert [turn.prompt for turn in derived] == ["先做这个", "再做那个"]
    assert [turn.ordinal for turn in derived] == [1, 2]


async def test_usage_is_filled_in_when_the_run_finishes(engine: AsyncEngine) -> None:
    """用量由 run 跑完那一条事件补齐，实时那侧不该是空的。"""

    store = TranscriptStore()
    runner, _step_store, queue = _runner(engine, _says("好"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await _submit(runner, queue, conversation_id, "来")
    await runner.shutdown()

    turn = _replay(store, conversation_id)[0]
    assert turn.usage is not None
    assert turn.steps[0].usage is not None


async def test_restart_sweep_settles_rows_nobody_will_come_back_for(engine: AsyncEngine) -> None:
    """重启后表里留下的行要收拾掉：在跑的判失败，排队的判撤销。

    留着不动的话，那段对话会永远「正在跑」，之后发的每一条都排在一个不存在的运行后面。
    """

    queue = PromptQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    first = await queue.submit(
        prompt_id="prm_a",
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text="一"),),
        now=now,
    )
    second = await queue.submit(
        prompt_id="prm_b",
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text="二"),),
        now=now,
    )
    assert (first.status, second.status) == ("running", "queued")

    assert await queue.discard_stale(now=now) == 2
    assert (await queue.get("prm_a")).status == "failed"  # pyright: ignore[reportOptionalMemberAccess]
    assert (await queue.get("prm_b")).status == "aborted"  # pyright: ignore[reportOptionalMemberAccess]


async def test_resubmitting_the_same_prompt_id_does_not_start_a_second_run(
    engine: AsyncEngine,
) -> None:
    """客户端重试同一个 prompt id 只算一条：不多起一次运行，也不多出一条排队。"""

    queue = PromptQueue(engine)
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
        )
    view = await queue.view(conversation_id)
    assert view.active is not None
    assert view.queued == ()


async def test_the_same_prompt_id_in_another_conversation_is_rejected(
    engine: AsyncEngine,
) -> None:
    """消息 id 是客户端铸的，两个人撞号是可能的。

    不比对话就返回已有那条的话，撞上的人会拿到别人的消息记录，而他自己那条从来没被收下。
    """

    queue = PromptQueue(engine)
    now = datetime.now(UTC)
    await queue.submit(
        prompt_id="prm_shared",
        conversation_id="c-mine",
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text="我的"),),
        now=now,
    )
    with pytest.raises(Conflict):
        await queue.submit(
            prompt_id="prm_shared",
            conversation_id="c-yours",
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            content=(TextContent(text="你的"),),
            now=now,
        )


async def test_aborting_a_prompt_from_another_conversation_is_not_found(
    engine: AsyncEngine,
) -> None:
    """光凭一个消息 id 停不掉别人那段对话里的运行。"""

    store = TranscriptStore()
    runner, _step_store, queue = _runner(engine, _says("好"), store=store)
    prompt_id = await _submit(runner, queue, "c-owner", "跑起来")

    with pytest.raises(NotFound):
        await runner.abort("c-someone-else", prompt_id)

    await runner.shutdown()
