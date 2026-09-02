"""prompt 队列与运行驱动的全链路验收（真实 Postgres + FunctionModel）。

单测那几条是手工把事件喂给投影器的，盖不住这几段接线：``run_stream_events`` 的对接、两套
run id 合一之后终态查得出来、一轮跑完接上排队的下一条、实时那份与刷新之后现推的那份一致。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Sequence
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import (
    INTERRUPTED_TOOL_RETURN_CONTENT,
    ModelMessage,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from pydantic_ai_harness.step_persistence import StepPersistence
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.common.errors import Conflict, NotFound
from iclip.harness.prompts import PromptQueue
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.transcript.from_messages import run_ids_from_messages
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.service import TranscriptService
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.ops import MAIN_AGENT_ID, TextContent, TranscriptTurn

AGENT_ID = "storyboard"
MAX_CONTEXT_TOKENS = 4096
OWNER = uuid.UUID("11111111-2222-3333-4444-555555555555")
LOCKED_BY = "w-test"
"""这一份里 runner 的租约主人。写死好让测试能直接改库里那一列，装出「别人接手了」。"""
DEAD = "w-dead"
"""上一条命的租约主人：它留下的行没人再刷心跳。"""


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "TRUNCATE agent_runtime.runs, agent_runtime.events, agent_runtime.snapshots, "
                "agent_runtime.tool_effects, agent_runtime.media, agent_runtime.prompts, "
                "agent_runtime.prompt_runs"
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


def _waits(entered: asyncio.Event, gate: asyncio.Event) -> FunctionModel:
    """卡住不出话，直到放行。用来把「这一条正在跑」钉住，不靠等一个时长。"""

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        entered.set()
        await gate.wait()
        yield "跑完了"

    return FunctionModel(stream_function=stream)


def _records(
    seen: list[list[ModelMessage]], entered: asyncio.Event, gate: asyncio.Event
) -> FunctionModel:
    """记下每次被问时收到的整份消息，第一次卡住等放行。

    第一次之后不再卡：追加要是赶上了，这个模型会被问第二次，而「问了第二次」正是那道 redirect
    生效的证据。
    """

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


def _texts(messages: list[ModelMessage]) -> list[str]:
    """这份消息里用户说过的话。"""

    return [
        part.content
        for message in messages
        for part in getattr(message, "parts", ())
        if isinstance(part, UserPromptPart) and isinstance(part.content, str)
    ]


def _calls_tool(name: str) -> FunctionModel:
    """第一次被问就要调这件工具，之后不该再被问到。"""

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        yield {0: DeltaToolCall(name=name, json_args="{}", tool_call_id="call_boom")}

    return FunctionModel(stream_function=stream)


def _runner(
    engine: AsyncEngine,
    model: FunctionModel,
    *,
    store: TranscriptStore,
    tools: Sequence[Any] = (),
    locked_by: str = LOCKED_BY,
) -> tuple[ConversationRunner, PgStepStore, PromptQueue]:
    step_store = PgStepStore(engine)
    agent = Agent(
        model,
        name=AGENT_ID,
        tools=list(tools),
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
        context_limits={AGENT_ID: MAX_CONTEXT_TOKENS},
        heartbeat_seconds=10,
        lease_seconds=30,
        sweep_seconds=15,
        locked_by=locked_by,
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
        locked_by=runner.locked_by,
    )
    await runner.submit(row)
    return prompt_id


async def _expire_lease(engine: AsyncEngine, conversation_id: str) -> None:
    """把这段对话里在跑那条的心跳拨到一小时前，让清扫认定它失联。不等一个真的租约。"""

    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE agent_runtime.prompts SET heartbeat_at = now() - INTERVAL '1 hour' "
                "WHERE conversation_id = :conversation_id AND status = 'running'"
            ),
            {"conversation_id": conversation_id},
        )


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
    """比结构、比 id、比正文、比工具卡的状态与轮上的错误文字，不比时刻。

    工具卡的状态和轮的 ``error`` 也得比：这两样对不上，界面会在刷新的瞬间从「中断」变成「还在
    转」、或者失败的原因凭空消失，而只比结构的话这类分叉一条都看不出来。
    """

    return [
        (
            turn.turn_id,
            turn.ordinal,
            turn.state,
            turn.prompt,
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
    """跑一轮：实时那份与刷新之后现推的那份，结构逐字相同，终态都读得出「跑完了」。"""

    store = TranscriptStore()
    runner, step_store, queue = _runner(engine, _says("好的，我来写"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await _submit(runner, queue, conversation_id, "写三个镜头")
    await runner.shutdown()

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
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

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
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

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [turn.prompt for turn in derived] == ["先做这个", "再做那个"]
    assert [turn.ordinal for turn in derived] == [1, 2]


async def test_usage_is_filled_in_when_the_run_finishes(engine: AsyncEngine) -> None:
    """用量由 run 跑完那一条事件补齐，实时那侧不该是空的。"""

    store = TranscriptStore()
    runner, step_store, queue = _runner(engine, _says("好"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await _submit(runner, queue, conversation_id, "来")
    await runner.shutdown()

    turn = _replay(store, conversation_id)[0]
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
    ).page(conversation_id, runtime_agent_id=AGENT_ID)
    assert restored.meta.agent == live_status


async def test_sweep_settles_an_expired_lease_and_wakes_the_queue(engine: AsyncEngine) -> None:
    """租约过期的行判失败并写下原因，排着的那条由清扫叫醒、跑完。

    不收拾的话那段对话会永远「正在跑」，之后发的每一条都排在一个不存在的运行后面。
    """

    store = TranscriptStore()
    runner, _step_store, queue = _runner(engine, _says("轮到我了"), store=store)
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

    await _expire_lease(engine, conversation_id)
    await runner.sweep_once()
    await _drained(queue, conversation_id)
    await runner.shutdown()

    lost = await queue.get("prm_a")
    assert lost is not None
    assert lost.status == "failed"
    assert lost.interrupt_reason  # 界面要说得出这一轮为什么没了
    assert lost.locked_by is None

    woken = await queue.get("prm_b")
    assert woken is not None
    assert woken.status == "completed"
    assert woken.run_id is not None  # 它自己起过一次 run，不是被顺手标掉的
    assert woken.locked_by == LOCKED_BY  # 租约归接手的这个进程


async def test_a_live_lease_is_left_alone(engine: AsyncEngine) -> None:
    """心跳还新鲜的在跑行清扫不动它——那是别的进程正经跑着的一轮。"""

    runner, _step_store, queue = _runner(engine, _says("好"), store=TranscriptStore())
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
    """排着的那条不随进程消失：新起的进程清扫时把它顶上来跑完。"""

    queue = PromptQueue(engine)
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
    # 上一条命自己给在跑那条收了尾，然后就没了；排着的那条留在库里没人叫。
    await queue.finish("prm_head", status="completed", now=now, locked_by=DEAD)

    runner, _step_store, _queue = _runner(engine, _says("轮到我了"), store=TranscriptStore())
    await runner.sweep_once()
    await _drained(queue, conversation_id)
    await runner.shutdown()

    tail = await queue.get("prm_tail")
    assert tail is not None
    assert tail.status == "completed"
    assert tail.locked_by == LOCKED_BY


async def test_a_run_whose_lease_was_taken_cancels_itself(engine: AsyncEngine) -> None:
    """租约易手之后刷不到心跳，这一轮就地取消，而这个进程再改不动库里那一行。

    不取消的话同一段对话会有两个进程在跑，而结局归接手的那一方。
    """

    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = _runner(engine, _waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await _submit(runner, queue, conversation_id, "先做这个")
    await entered.wait()  # 这一条真的跑起来了

    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE agent_runtime.prompts SET locked_by = 'w-other' WHERE prompt_id = :id"),
            {"id": prompt_id},
        )
    await runner.heartbeat_once()
    gate.set()  # 放模型走完这一步，让取消有机会被收下
    await runner.shutdown()

    # 客户端看到这一轮被取消了。
    assert [turn.state for turn in _replay(store, conversation_id)] == ["cancelled"]

    # 那一行没被这次 runner 的 finish 动过：结局归接手的那一方。
    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "running"
    assert row.locked_by == "w-other"
    assert row.finished_at is None


async def test_only_the_running_row_carries_a_lease(engine: AsyncEngine) -> None:
    """判成在跑的那条当场铸租约，排着的两列留空；队首顶上来时也带租约。"""

    queue = PromptQueue(engine)
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

    await queue.finish("prm_head", status="completed", now=now, locked_by=LOCKED_BY)
    started = await queue.start_next(conversation_id, locked_by="w-next")
    assert started is not None
    assert started.locked_by == "w-next"
    assert started.heartbeat_at is not None


async def test_attach_run_maps_every_run_to_its_prompt(engine: AsyncEngine) -> None:
    """一条 prompt 起过的每次 run 都记进 ``prompt_runs``：transcript 靠它把它们合成一轮。

    映射按对话取：别的对话的 run 混进来的话，那段对话的轮会被合到一起去。
    """

    queue = PromptQueue(engine)
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
    # 同一条 prompt 起两次 run：第一次断了，第二次续跑。
    await queue.attach_run("prm_mine", "r-first", locked_by=LOCKED_BY)
    await queue.attach_run("prm_mine", "r-second", locked_by=LOCKED_BY)
    await queue.attach_run("prm_yours", "r-other", locked_by=LOCKED_BY)

    assert await queue.prompt_of_runs("c-mine") == {
        "r-first": "prm_mine",
        "r-second": "prm_mine",
    }
    assert await queue.prompt_of_runs("c-yours") == {"r-other": "prm_yours"}

    # 按任一次 run 都找回同一条 prompt；``prompts.run_id`` 记的是最近那次。
    first = await queue.get_by_run("r-first")
    second = await queue.get_by_run("r-second")
    assert first is not None
    assert second is not None
    assert (first.prompt_id, second.prompt_id) == ("prm_mine", "prm_mine")
    assert second.run_id == "r-second"


async def test_attach_run_writes_nothing_when_the_lease_moved_on(engine: AsyncEngine) -> None:
    """租约易手之后 ``attach_run`` 两处都不写：那一轮的结局归接手的那一方。

    只挡住 ``prompts.run_id`` 却把映射写进去的话，一条不属于自己的 run 会被算进那一轮。
    """

    queue = PromptQueue(engine)
    await queue.submit(
        prompt_id="prm_fenced",
        conversation_id="c-fenced",
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        content=(TextContent(text="走"),),
        now=datetime.now(UTC),
        locked_by=LOCKED_BY,
    )

    await queue.attach_run("prm_fenced", "r-stale", locked_by="w-other")

    row = await queue.get("prm_fenced")
    assert row is not None
    assert row.run_id is None
    assert await queue.prompt_of_runs("c-fenced") == {}
    assert (await queue.get_by_run("r-stale")) is None


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
            locked_by=LOCKED_BY,
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


async def test_aborting_the_conversation_leaves_nothing_queued_to_pick_up(
    engine: AsyncEngine,
) -> None:
    """停整段对话：排着的全撤掉，而且没有一条被顶上来接着跑。

    先取消在跑的那条、再逐条撤队列的话，取消触发的收尾会把队首顶上来——用户按了停止，屏幕上
    反而开始跑下一条。
    """

    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = _runner(engine, _waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await _submit(runner, queue, conversation_id, "先做这个")
    second = await _submit(runner, queue, conversation_id, "再做那个")
    third = await _submit(runner, queue, conversation_id, "还有这个")
    await entered.wait()  # 第一条真的跑起来了

    await runner.abort_conversation(conversation_id)
    gate.set()  # 放模型走完这一步，让取消有机会被收下
    await _drained(queue, conversation_id)
    await runner.shutdown()

    for prompt_id in (second, third):
        row = await queue.get(prompt_id)
        assert row is not None
        assert row.status == "aborted"
        assert row.run_id is None  # 没起过 run，不是跑了一半被停的

    # 客户端屏幕上只有被停的那一轮：多出第二轮就说明队首被顶上来跑过。
    assert [turn.prompt for turn in _replay(store, conversation_id)] == ["先做这个"]


async def test_aborting_a_queued_prompt_marks_it_aborted(engine: AsyncEngine) -> None:
    """停掉排着的那一条：它没有租约，走不了带 fence 的收尾，状态照样要落到「撤销了」。"""

    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = _runner(engine, _waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await _submit(runner, queue, conversation_id, "先做这个")
    second = await _submit(runner, queue, conversation_id, "再做那个")
    await entered.wait()  # 第一条真的跑起来了，第二条只能排着

    await runner.abort(conversation_id, second)
    row = await queue.get(second)
    assert row is not None
    assert row.status == "aborted"

    gate.set()
    await _drained(queue, conversation_id)
    await runner.shutdown()


async def test_an_append_landing_after_the_last_model_request_still_reaches_the_model(
    engine: AsyncEngine,
) -> None:
    """追加赶在这一轮最后一次模型请求之后到，仍然进得去。

    官方在 run 本来要结束时会把晚到的 asap 捞出来做一次 redirect。追加要是先攒在我们自己手上、
    等下一次模型请求前才递给官方，这一轮就没有下一次请求了，那道 redirect 捞不到它——模型从没
    见过这句话，而库里那行却记着它已经交付。
    """

    seen: list[list[ModelMessage]] = []
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = _runner(engine, _records(seen, entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await _submit(runner, queue, conversation_id, "先做这个")
    second = await _submit(runner, queue, conversation_id, "临时插一句")
    await entered.wait()  # 第一条真的跑起来了，模型正卡在第一次请求里

    await runner.steer(conversation_id, (second,))
    gate.set()
    await _drained(queue, conversation_id)
    await runner.shutdown()

    # 模型被问了第二次，而且第二次收到了那句追加：这就是 redirect 生效。
    assert len(seen) == 2
    assert "临时插一句" in _texts(seen[1])

    # 追加没有自成一轮，它是这一轮里的一个用户块。
    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [turn.prompt for turn in derived] == ["先做这个"]
    assert "临时插一句" in [
        getattr(frame, "text", None)
        for turn in derived
        for step in turn.steps
        for frame in step.frames
    ]

    # 那行 prompt 记在这一轮的 run 名下，结局跟着它。
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
    """按了停止：已经递进去的那条追加跟着这一轮一起撤销，不退回队列。

    退回队列等于紧接着把它当新的一轮开跑——用户刚说的是别跑了。
    """

    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = _runner(engine, _waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await _submit(runner, queue, conversation_id, "先做这个")
    second = await _submit(runner, queue, conversation_id, "临时插一句")
    await entered.wait()

    await runner.steer(conversation_id, (second,))
    await runner.abort_conversation(conversation_id)
    gate.set()
    await _drained(queue, conversation_id)
    await runner.shutdown()

    appended = await queue.get(second)
    assert appended is not None
    assert appended.status == "aborted"

    # 屏幕上只有被停的那一轮：多出一轮就说明那条追加被退回队列又开跑了。
    assert [turn.prompt for turn in _replay(store, conversation_id)] == ["先做这个"]


async def test_an_append_the_run_never_read_goes_back_to_the_queue(engine: AsyncEngine) -> None:
    """一条追加要么进这次 run，要么退回 ``queued``。

    只在收场清扫那一处走得到「递进去了但没被读到」，而它落在 run 收场前后那一瞬，测不成稳定的
    竞态，所以这里钉的是它依赖的两步：记上 → 退回，以及退回之后那行干干净净。
    """

    queue = PromptQueue(engine)
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
    # 协议的状态联合里没有 steered，漏出去客户端整帧被 zod 拒掉且不报错。
    assert moved.as_entity().status == "running"
    # 它已经不算排队的了，队列视图里看不到。
    assert (await queue.view(conversation_id)).queued == ()

    (back,) = await queue.requeue_steered(("prm_tail",))
    assert back.status == "queued"
    assert back.run_id is None
    assert back.steered_at is None
    assert [row.prompt_id for row in (await queue.view(conversation_id)).queued] == ["prm_tail"]


async def test_sweep_settles_an_append_that_rode_a_lost_run(engine: AsyncEngine) -> None:
    """租约过期时，递进那次 run 的 ``steered`` 行跟着判失败：那次 run 随进程一起没了。"""

    queue = PromptQueue(engine)
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
    await queue.attach_run("prm_running", run_id, locked_by=DEAD)
    await queue.mark_steered(("prm_appended",), run_id=run_id, now=now)

    await _expire_lease(engine, conversation_id)
    runner, _step_store, _queue = _runner(engine, _says("好"), store=TranscriptStore())
    await runner.sweep_once()
    await runner.shutdown()

    appended = await queue.get("prm_appended")
    assert appended is not None
    assert appended.status == "failed"


async def test_appending_when_nothing_is_running_is_a_conflict(engine: AsyncEngine) -> None:
    """没有在跑的运行，追加无处可去。"""

    store = TranscriptStore()
    runner, _step_store, queue = _runner(engine, _says("好"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await _submit(runner, queue, conversation_id, "先做这个")
    await _drained(queue, conversation_id)
    await runner.shutdown()

    with pytest.raises(Conflict):
        await runner.steer(conversation_id, (prompt_id,))


async def test_a_run_that_died_mid_tool_still_shows_up_after_a_refresh(
    engine: AsyncEngine,
) -> None:
    """工具跑到一半炸掉的那一轮，刷新之后还看得见，而且两条路给出同一份结构。

    这种运行只落得下一份 ``interrupted`` 快照（那次工具调用没有返回）。默认读取路径跳过中断的
    快照——那个默认是给「接着跑」设的，显示不接着跑。不算上的话，用户明明看到它写到一半报了错，
    刷新之后连自己打的那句话都没了。
    """

    def boom() -> str:
        raise RuntimeError("工具炸了")

    store = TranscriptStore()
    runner, step_store, queue = _runner(engine, _calls_tool("boom"), store=store, tools=[boom])
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await _submit(runner, queue, conversation_id, "把这三个镜头重新出图")
    await _drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "failed"

    # 库里只有中断的那一份：按完整的读什么都取不到。
    assert (await step_store.latest_conversation_snapshot(conversation_id=conversation_id)) is None
    interrupted = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert interrupted is not None

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [turn.prompt for turn in derived] == ["把这三个镜头重新出图"]
    assert [turn.state for turn in derived] == ["failed"]

    # 没等到返回的工具卡收成错的那一档，不是永远转圈。
    tools = [
        frame
        for turn in derived
        for step in turn.steps
        for frame in step.frames
        if frame.kind == "tool"
    ]
    assert [frame.state for frame in tools] == ["error"]

    # 两条路逐字相同：刷新的瞬间界面不该变形。
    assert _skeleton(derived) == _skeleton(_replay(store, conversation_id))


async def test_the_close_out_result_tells_the_model_the_call_failed(
    engine: AsyncEngine,
) -> None:
    """补给悬空调用的那份结果，落进消息里必须是失败，不能是成功。

    裸字符串会被官方包成 ``ToolReturn``，``outcome`` 是 ``success``——等于告诉模型这次调用成功了、
    返回值就是那句话，模型可能照着往下做。文字用官方那条常量，与官方自己补悬空调用时说的一致。
    """

    def boom() -> str:
        raise RuntimeError("工具炸了")

    store = TranscriptStore()
    runner, step_store, queue = _runner(engine, _calls_tool("boom"), store=store, tools=[boom])
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await _submit(runner, queue, conversation_id, "先做这个")
    await _drained(queue, conversation_id)

    store2 = TranscriptStore()
    runner2, _step_store2, queue2 = _runner(engine, _says("好"), store=store2)
    await _submit(runner2, queue2, conversation_id, "再做那个")
    await _drained(queue2, conversation_id)
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
    """失败那一轮占着 1 号，下一条是 2 号。

    轮号按「历史那侧推得出几次运行」数。历史算上了中断的快照而这里没算的话，两轮会同号——屏幕上
    两个 t1，而实时那份会把历史那份顶掉，失败那一轮在眼前闪一下就没了。
    """

    def boom() -> str:
        raise RuntimeError("工具炸了")

    store = TranscriptStore()
    runner, step_store, queue = _runner(engine, _calls_tool("boom"), store=store, tools=[boom])
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await _submit(runner, queue, conversation_id, "先做这个")
    await _drained(queue, conversation_id)

    # 换一个不炸的模型跑第二条：同一个 runner，只是这次的 agent 会正常回话。
    store2 = TranscriptStore()
    runner2, _step_store2, queue2 = _runner(engine, _says("好"), store=store2)
    await _submit(runner2, queue2, conversation_id, "再做那个")
    await _drained(queue2, conversation_id)
    await runner.shutdown()
    await runner2.shutdown()

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.ordinal) for turn in derived] == [("t1", 1), ("t2", 2)]
    assert [turn.state for turn in derived] == ["failed", "completed"]


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
