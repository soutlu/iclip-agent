"""运行事件流在真 Redis 上的行为：断点续读、别人读不到、窗口过期、中断封盘。

「客户端断开不取消运行」需要真 TCP，在 ``test_run_detached.py``。

模型用官方 ``test``，所以这一层不需要任何厂商凭证。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import InMemoryStepStore
from redis.asyncio import Redis

from iclip.common.errors import Conflict, NotFound
from iclip.config import ResolvedAgent
from iclip.harness.agents import AgentDefinition, build_agent_registry
from iclip.harness.run_stream_redis import RedisRunStream
from iclip.harness.runs import INTERRUPTED_CODE, RunBroker, RunStreamSettings
from tests.helpers.agui import run_input, sse_cursors, sse_events
from tests.integration_no_llm.conftest import (
    TEST_MODEL_NAME,
    make_client,
    register_and_login,
    set_roles_in_db,
)

AGENT_ID = "storyboard"
URL = f"/agents/{AGENT_ID}/chat"
OWNER = "11111111-1111-1111-1111-111111111111"
CONVERSATION = "22222222-2222-2222-2222-222222222222"


async def no_deps(_conversation_id: str, _run_id: str) -> object:
    """直连 broker 的用例不经过 HTTP 面，所以没有对话要核对。"""

    return None


@pytest.fixture
def agent_declarations(tmp_path: Path) -> tuple[ResolvedAgent, ...]:
    spec_dir = tmp_path / AGENT_ID
    spec_dir.mkdir(parents=True, exist_ok=True)
    spec = spec_dir / "agent.yaml"
    spec.write_text("", encoding="utf-8")
    return (
        ResolvedAgent(
            agent_id=AGENT_ID,
            spec=spec,
            instructions=None,
            model=TEST_MODEL_NAME,
            skills=None,
            capabilities=(),
            subagents=(),
        ),
    )


@pytest.fixture
async def redis_client(redis_url: str) -> AsyncGenerator[Redis]:
    client = Redis.from_url(redis_url, decode_responses=True)
    try:
        await client.flushdb()
        yield client
    finally:
        await client.aclose()


def broker_for(
    tmp_path: Path, client: Redis, settings: RunStreamSettings | None = None
) -> RunBroker:
    """直连事件流的 broker：本文件里那几条时间相关的行为只在这一层能测。"""

    spec_dir = tmp_path / AGENT_ID
    spec_dir.mkdir(parents=True, exist_ok=True)
    spec = spec_dir / "agent.yaml"
    spec.write_text("", encoding="utf-8")
    registry = build_agent_registry(
        (AgentDefinition(agent_id=AGENT_ID, spec=spec, model="m"),),
        step_store=InMemoryStepStore(),
        models={"m": TestModel()},
    )
    return RunBroker(registry, RedisRunStream(client), settings)


async def login_as_editor(
    client: httpx.AsyncClient, pg_url: str, *, username: str = "luke"
) -> None:
    email = f"{username}@example.com"
    await register_and_login(client, username=username, email=email)
    await set_roles_in_db(pg_url, email, ["editor"])


async def drain(response: httpx.Response) -> str:
    return "".join([chunk async for chunk in response.aiter_text()])


async def new_conversation(client: httpx.AsyncClient) -> str:
    """开一段对话，拿它的 id 当 AG-UI 的 threadId。

    会话必须先由服务端建出来：agent 端点只认自己发出去的 id。
    """

    created = await client.post("/conversations", json={"agentId": AGENT_ID})
    assert created.status_code == 201, created.text
    return str(created.json()["conversation"]["id"])


async def test_resume_continues_from_last_event_id(client: httpx.AsyncClient, pg_url: str) -> None:
    """标准 SSE 的 Last-Event-ID：只补发那之后的事件。"""

    await login_as_editor(client, pg_url)
    conversation = await new_conversation(client)
    body = run_input(thread_id=conversation, run_id="run-resume")

    async with client.stream("POST", URL, json=body) as response:
        first = await drain(response)
    all_cursors = sse_cursors(first)
    assert len(all_cursors) > 1

    resumed = await client.get(
        f"{URL}/{conversation}/run-resume", headers={"last-event-id": all_cursors[0]}
    )
    assert sse_cursors(resumed.text) == all_cursors[1:]


async def test_another_users_run_is_not_visible(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """流名字里带着归属：换个人拿同一个运行 id 什么都读不到。"""

    await login_as_editor(client, pg_url)
    conversation = await new_conversation(client)
    body = run_input(thread_id=conversation, run_id="run-mine")
    async with client.stream("POST", URL, json=body) as response:
        await drain(response)

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mallory")
        stolen = await other.get(f"{URL}/{conversation}/run-mine")

    assert stolen.status_code == 404


async def test_expired_replay_window_is_refused(tmp_path: Path, redis_client: Redis) -> None:
    """过了重放窗口就明说接不上了，绝不默默跳到当前位置假装接上。"""

    broker = broker_for(
        tmp_path, redis_client, RunStreamSettings(replay_window_seconds=1, block_ms=200)
    )
    run_key = await broker.open(
        owner=OWNER,
        agent_id=AGENT_ID,
        body=json.dumps(run_input(run_id="run-window")).encode(),
        deps=no_deps,
    )
    async for _ in await broker.feed(run_key, after=None):
        pass

    await asyncio.sleep(1.5)

    with pytest.raises(Conflict):
        await broker.feed(run_key, after="0-1")
    with pytest.raises(NotFound):
        await broker.feed(run_key, after=None)


async def test_gone_producer_is_sealed_as_retryable(tmp_path: Path, redis_client: Redis) -> None:
    """生产者没留下结局就消失：读的人把「中断了，可重试」写进流收尾。

    不编造跑完了的结局——那会让客户端以为拿到了完整结果。
    """

    settings = RunStreamSettings(lease_seconds=1, block_ms=200)
    broker = broker_for(tmp_path, redis_client, settings)
    stream = RedisRunStream(redis_client)
    run_key = f"{OWNER}:{CONVERSATION}:{AGENT_ID}:run-orphan"

    assert await stream.claim(run_key, lease_seconds=settings.lease_seconds)
    await stream.append(run_key, 'data: {"type":"RUN_STARTED"}\n\n', last=False)
    await asyncio.sleep(1.5)  # 租约到期，等于生产者不在了

    first_read = [frame async for frame in await broker.feed(run_key, after=None)]
    assert [event["type"] for event in sse_events("".join(first_read))] == [
        "RUN_STARTED",
        "RUN_ERROR",
    ]
    assert sse_events("".join(first_read))[-1]["code"] == INTERRUPTED_CODE

    # 结局写进了流，所以后来的人看到的是同一个结局，不会再等一轮。
    second_read = [frame async for frame in await broker.feed(run_key, after=None)]
    assert sse_cursors("".join(second_read)) == sse_cursors("".join(first_read))


async def test_second_post_appends_nothing(tmp_path: Path, redis_client: Redis) -> None:
    """同一个运行 id 再发起一次：流里一帧都不会多，也就没有第二次模型调用。

    断言必须落在流的长度上，不能比对读到的事件：真起了第二个生产者时，它的帧
    会全部落在第一帧终帧之后，而读的人在终帧就停了，从读到的内容里看不出任何
    异常——受损的是白烧掉的模型调用和多出来的一条运行记录。
    """

    broker = broker_for(tmp_path, redis_client, RunStreamSettings(block_ms=200))
    body = json.dumps(run_input(run_id="run-twice")).encode()
    run_key = await broker.open(owner=OWNER, agent_id=AGENT_ID, body=body, deps=no_deps)
    async for _ in await broker.feed(run_key, after=None):
        pass
    written = await redis_client.xlen(f"iclip:agent:run:{run_key}")

    again = await broker.open(owner=OWNER, agent_id=AGENT_ID, body=body, deps=no_deps)
    # 万一真起了第二个生产者，给它留出足够时间把帧写进来。
    await asyncio.sleep(0.3)

    assert again == run_key
    assert await redis_client.xlen(f"iclip:agent:run:{run_key}") == written


async def test_resume_at_the_end_of_a_finished_run_just_closes(
    tmp_path: Path, redis_client: Redis
) -> None:
    """从终帧之后续读：收流，不编造中断事件（原生 EventSource 会这么重连）。"""

    broker = broker_for(tmp_path, redis_client, RunStreamSettings(block_ms=200))
    run_key = await broker.open(
        owner=OWNER,
        agent_id=AGENT_ID,
        body=json.dumps(run_input(run_id="run-tail")).encode(),
        deps=no_deps,
    )
    frames = [frame async for frame in await broker.feed(run_key, after=None)]
    last_cursor = sse_cursors("".join(frames))[-1]

    tail = [frame async for frame in await broker.feed(run_key, after=last_cursor)]

    assert tail == []


async def test_sealed_stream_gets_a_replay_window(tmp_path: Path, redis_client: Redis) -> None:
    """读的人给流收尾时也要定窗口，否则进程每崩一次就留下一条永不过期的流。"""

    settings = RunStreamSettings(lease_seconds=1, block_ms=200, replay_window_seconds=120)
    broker = broker_for(tmp_path, redis_client, settings)
    stream = RedisRunStream(redis_client)
    run_key = f"{OWNER}:{CONVERSATION}:{AGENT_ID}:run-ttl"

    assert await stream.claim(run_key, lease_seconds=settings.lease_seconds)
    await stream.append(run_key, 'data: {"type":"RUN_STARTED"}\n\n', last=False)
    await asyncio.sleep(1.5)
    async for _ in await broker.feed(run_key, after=None):
        pass

    ttl = await redis_client.ttl(f"iclip:agent:run:{run_key}")
    assert 0 < ttl <= settings.replay_window_seconds
