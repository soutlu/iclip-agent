"""agent 端点的进程内契约：CSRF 防线、错误映射、事件流与续读。

不碰数据库和 Redis：主体由一个测试中间件直接写入 ``request.state.principal``，
事件流用内存替身，因此这里验的是路由自身的行为。认证与 DB 的联动、真 Redis
上的重放语义都在 integration_no_llm。
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import InMemoryStepStore

from iclip.common.errors import DomainError
from iclip.domains.agents.api import create_agents_router
from iclip.domains.identity.models import Principal
from iclip.harness.agents import AgentDefinition, build_agent_registry
from iclip.harness.runs import RunBroker
from iclip.platform.http import status_code_for
from tests.helpers.agui import run_input, sse_cursors, sse_events
from tests.helpers.run_stream import MemoryRunStream

AGENT_ID = "storyboard"
URL = f"/agents/{AGENT_ID}/chat"
RUN_ID = "run-1"
BODY = run_input(run_id=RUN_ID)


def principal(*permissions: str) -> Principal:
    return Principal(
        kind="user",
        user_id=uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="tester",
    )


_RUNNER = principal("agent:run")


def build_test_app(broker: RunBroker, *, granted: Principal | None = _RUNNER) -> FastAPI:
    """组装一个只挂 agent 路由的 app，复用组合根同一份领域错误映射。"""

    app = FastAPI()

    @app.middleware("http")
    async def _inject_principal(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if granted is not None:
            request.state.principal = granted
        return await call_next(request)

    @app.exception_handler(DomainError)
    async def _domain_error(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=status_code_for(exc), content={"detail": str(exc)})

    app.include_router(create_agents_router(broker))
    return app


@pytest.fixture
def stream() -> MemoryRunStream:
    return MemoryRunStream()


@pytest.fixture
def broker(tmp_path: Path, stream: MemoryRunStream) -> RunBroker:
    spec_dir = tmp_path / AGENT_ID
    spec_dir.mkdir()
    spec = spec_dir / "agent.yaml"
    spec.write_text("", encoding="utf-8")
    registry = build_agent_registry(
        (AgentDefinition(agent_id=AGENT_ID, spec=spec, model="m"),),
        step_store=InMemoryStepStore(),
        models={"m": TestModel()},
    )
    return RunBroker(registry, stream)


def client_for(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def kinds(body: str) -> list[str]:
    """SSE 正文里的事件类型序列。"""

    return [str(event["type"]) for event in sse_events(body)]


async def start_run(client: httpx.AsyncClient, body: dict[str, object] | None = None) -> str:
    async with client.stream("POST", URL, json=body or BODY) as response:
        assert response.status_code == 200, await response.aread()
        return "".join([chunk async for chunk in response.aiter_text()])


async def resume_run(
    client: httpx.AsyncClient, *, run_id: str = RUN_ID, after: str | None = None
) -> str:
    headers = {"last-event-id": after} if after else None
    async with client.stream("GET", f"{URL}/{run_id}", headers=headers) as response:
        assert response.status_code == 200, await response.aread()
        return "".join([chunk async for chunk in response.aiter_text()])


async def test_missing_permission_is_403(broker: RunBroker) -> None:
    app = build_test_app(broker, granted=principal("agent:read"))
    async with client_for(app) as client:
        response = await client.post(URL, json=BODY)
    assert response.status_code == 403


async def test_no_principal_is_401(broker: RunBroker) -> None:
    app = build_test_app(broker, granted=None)
    async with client_for(app) as client:
        response = await client.post(URL, json=BODY)
    assert response.status_code == 401


async def test_resume_requires_permission(broker: RunBroker) -> None:
    app = build_test_app(broker, granted=principal("agent:read"))
    async with client_for(app) as client:
        response = await client.get(f"{URL}/{RUN_ID}")
    assert response.status_code == 403


async def test_non_json_content_type_is_415_without_running(
    broker: RunBroker, stream: MemoryRunStream
) -> None:
    """免检 content-type 必须在派发运行之前被挡掉。"""

    app = build_test_app(broker)
    async with client_for(app) as client:
        response = await client.post(URL, content=b"{}", headers={"content-type": "text/plain"})

    assert response.status_code == 415
    assert (stream.frames, stream.states) == ({}, {})


async def test_preflight_grants_nothing(broker: RunBroker) -> None:
    app = build_test_app(broker)
    async with client_for(app) as client:
        response = await client.request("OPTIONS", URL)
    assert response.status_code == 204
    assert not [h for h in response.headers if h.startswith("access-control-allow")]


async def test_unknown_agent_id_is_404(broker: RunBroker) -> None:
    app = build_test_app(broker)
    async with client_for(app) as client:
        started = await client.post("/agents/ghost/chat", json=BODY)
        resumed = await client.get(f"/agents/ghost/chat/{RUN_ID}")
    assert (started.status_code, resumed.status_code) == (404, 404)


async def test_malformed_body_is_422(broker: RunBroker) -> None:
    app = build_test_app(broker)
    async with client_for(app) as client:
        response = await client.post(URL, json={"not": "a run input"})
    assert response.status_code == 422


async def test_illegal_run_id_is_422(broker: RunBroker, stream: MemoryRunStream) -> None:
    """运行 id 会成为流名字的一部分，形状不合法要在算名字之前就拒掉。"""

    app = build_test_app(broker)
    async with client_for(app) as client:
        response = await client.get(f"{URL}/other-user:storyboard:run-1")

    assert response.status_code == 422
    assert stream.frames == {}


async def test_illegal_cursor_is_422_before_streaming(broker: RunBroker) -> None:
    """位置来自客户端。形状不对必须当场拒，不能等到流开了才在中途炸。"""

    app = build_test_app(broker)
    async with client_for(app) as client:
        await start_run(client)
        response = await client.get(f"{URL}/{RUN_ID}", headers={"last-event-id": "not-a-cursor"})

    assert response.status_code == 422


async def test_resume_at_the_end_just_closes(broker: RunBroker) -> None:
    """从终帧之后续读：已经没有新东西了，就此收流——不许凭空造一个中断事件。

    浏览器原生 EventSource 在流结束后会自动带着最后一个 id 重连，所以这条路
    是常态，不是边角。
    """

    app = build_test_app(broker)
    async with client_for(app) as client:
        first = await start_run(client)
        resumed = await resume_run(client, after=sse_cursors(first)[-1])

    assert resumed == ""


async def test_resume_of_unknown_run_is_404(broker: RunBroker) -> None:
    app = build_test_app(broker)
    async with client_for(app) as client:
        response = await client.get(f"{URL}/never-started")
    assert response.status_code == 404


async def test_run_streams_frames_with_cursors(broker: RunBroker) -> None:
    app = build_test_app(broker)
    async with client_for(app) as client:
        body = await start_run(client)

    types = kinds(body)
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    # 每帧都带位置，客户端断线时才有东西可报回来。
    assert len(sse_cursors(body)) == len(types)


async def test_resume_replays_from_cursor(broker: RunBroker) -> None:
    """带上位置续读，只拿它之后的事件。"""

    app = build_test_app(broker)
    async with client_for(app) as client:
        first = await start_run(client)
        all_cursors = sse_cursors(first)
        resumed = await resume_run(client, after=all_cursors[0])

    assert sse_cursors(resumed) == all_cursors[1:]
    assert kinds(resumed)[-1] == "RUN_FINISHED"


async def test_resume_without_cursor_replays_everything(broker: RunBroker) -> None:
    app = build_test_app(broker)
    async with client_for(app) as client:
        first = await start_run(client)
        resumed = await resume_run(client)

    assert sse_cursors(resumed) == sse_cursors(first)


async def test_second_post_attaches_instead_of_running_again(
    broker: RunBroker, stream: MemoryRunStream
) -> None:
    """同一个运行 id 再 POST 一次是接着读，不是再跑一遍。"""

    app = build_test_app(broker)
    async with client_for(app) as client:
        first = await start_run(client)
        frames_after_first = len(next(iter(stream.frames.values())))
        second = await start_run(client)

    assert len(next(iter(stream.frames.values()))) == frames_after_first
    assert sse_cursors(second) == sse_cursors(first)
