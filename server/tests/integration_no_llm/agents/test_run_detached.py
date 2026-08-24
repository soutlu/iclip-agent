"""客户端真断开时，运行不受影响。

这条必须走真 TCP：httpx 的 ASGITransport 会把整个响应缓冲完才交出来，用它做
不出「读到一半就断」——那样测出来的「断开」其实是读完之后才松手，什么都没验
到。所以这里起一个真的 uvicorn。

模型卡在一道门上，所以断开的那一刻运行必然还没跑完，不靠时序碰巧。门放开后
运行继续，续读能看到断开之后才产生的内容和正常终态。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, DeltaToolCalls, FunctionModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.config import ResolvedAgent
from tests.helpers.agui import run_input, sse_events
from tests.integration_no_llm.conftest import (
    TEST_MODEL_NAME,
    register_and_login,
    set_roles_in_db,
)

AGENT_ID = "storyboard"
PATH = f"/agents/{AGENT_ID}/chat"
THREAD_ID = "thread-detached"
RUN_ID = "run-detached"
BEFORE = "断开之前"
AFTER = "断开之后"


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
def gate() -> asyncio.Event:
    return asyncio.Event()


@pytest.fixture
def models(gate: asyncio.Event) -> dict[str, FunctionModel]:
    """一个说到一半就停下等门的模型（覆写 conftest 的官方 test 替身）。"""

    async def gated(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        yield BEFORE
        await gate.wait()
        yield AFTER

    return {TEST_MODEL_NAME: FunctionModel(stream_function=gated)}


@asynccontextmanager
async def serving(app: FastAPI) -> AsyncGenerator[str]:
    """把 app 挂到本机一个临时端口上，返回它的 base URL。"""

    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="on")
    )
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


async def test_disconnect_leaves_the_run_running(
    app: FastAPI, pg_url: str, gate: asyncio.Event
) -> None:
    async with serving(app) as base_url:
        async with httpx.AsyncClient(base_url=base_url, timeout=30) as client:
            await register_and_login(client)
            await set_roles_in_db(pg_url, "luke@example.com", ["editor"])

            body = run_input(thread_id=THREAD_ID, run_id=RUN_ID)
            async with client.stream("POST", PATH, json=body) as response:
                assert response.status_code == 200
                async for chunk in response.aiter_text():
                    if BEFORE in chunk:
                        break  # 收到前半段就断线走人

            # 模型还卡在门上，所以这次运行此刻一定没跑完。
            assert not gate.is_set()
            gate.set()

            resumed = await client.get(f"{PATH}/{RUN_ID}")

        assert resumed.status_code == 200
        # 断开之后才产生的内容也在流里，说明运行没被那次断开带走。
        assert AFTER in resumed.text
        assert [event["type"] for event in sse_events(resumed.text)][-1] == "RUN_FINISHED"

    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            complete = (
                await conn.execute(
                    text(
                        "SELECT count(*) FROM agent_runtime.snapshots s "
                        "JOIN agent_runtime.runs r ON r.run_id = s.run_id "
                        "WHERE r.conversation_id = :cid AND s.state = 'complete'"
                    ),
                    {"cid": THREAD_ID},
                )
            ).scalar_one()
    finally:
        await engine.dispose()
    # 跑完的事实照样落库：断开没让它半途而废。
    assert complete >= 1
