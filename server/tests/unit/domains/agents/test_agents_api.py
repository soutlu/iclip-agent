"""agent 端点的进程内契约：CSRF 防线、错误映射、协议流。

不碰数据库：主体由一个测试中间件直接写入 ``request.state.principal``，
因此这里验的是路由自身的行为，认证与 DB 的联动在 integration_no_llm。
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from iclip.common.errors import DomainError
from iclip.domains.agents.api import AgentEventStream, create_agents_router
from iclip.domains.identity.models import Principal
from iclip.harness.agents import AgentDefinition, AgentRegistry, build_agent_registry
from iclip.platform.http import status_code_for

AGENT_ID = "storyboard"
URL = f"/agents/{AGENT_ID}/chat"
BODY = {
    "trigger": "submit-message",
    "id": "conversation-1",
    "messages": [{"id": "m1", "role": "user", "parts": [{"type": "text", "text": "hi"}]}],
}


def principal(*permissions: str) -> Principal:
    return Principal(
        kind="user",
        user_id=uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="tester",
    )


_RUNNER = principal("agent:run")


def build_test_app(stream: AgentEventStream, *, granted: Principal | None = _RUNNER) -> FastAPI:
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

    app.include_router(create_agents_router(stream))
    return app


@pytest.fixture
def registry(tmp_path: Path) -> AgentRegistry:
    spec_dir = tmp_path / AGENT_ID
    spec_dir.mkdir()
    spec = spec_dir / "agent.yaml"
    spec.write_text("model: test\n", encoding="utf-8")
    return build_agent_registry((AgentDefinition(agent_id=AGENT_ID, spec=spec),))


def client_for(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_missing_permission_is_403(registry: AgentRegistry) -> None:
    app = build_test_app(registry.stream, granted=principal("agent:read"))
    async with client_for(app) as client:
        response = await client.post(URL, json=BODY)
    assert response.status_code == 403


async def test_no_principal_is_401(registry: AgentRegistry) -> None:
    app = build_test_app(registry.stream, granted=None)
    async with client_for(app) as client:
        response = await client.post(URL, json=BODY)
    assert response.status_code == 401


async def test_non_json_content_type_is_415_without_running(registry: AgentRegistry) -> None:
    """免检 content-type 必须在派发运行之前被挡掉。"""

    ran = False

    def spy(agent_id: str, body: bytes, accept: str | None) -> AsyncIterator[str]:
        nonlocal ran
        ran = True
        return registry.stream(agent_id, body, accept)

    app = build_test_app(spy)
    async with client_for(app) as client:
        response = await client.post(URL, content=b"{}", headers={"content-type": "text/plain"})

    assert response.status_code == 415
    assert ran is False


async def test_preflight_grants_nothing(registry: AgentRegistry) -> None:
    app = build_test_app(registry.stream)
    async with client_for(app) as client:
        response = await client.request("OPTIONS", URL)
    assert response.status_code == 204
    assert not [h for h in response.headers if h.startswith("access-control-allow")]


async def test_unknown_agent_id_is_404(registry: AgentRegistry) -> None:
    app = build_test_app(registry.stream)
    async with client_for(app) as client:
        response = await client.post("/agents/ghost/chat", json=BODY)
    assert response.status_code == 404


async def test_malformed_body_is_422(registry: AgentRegistry) -> None:
    app = build_test_app(registry.stream)
    async with client_for(app) as client:
        response = await client.post(URL, json={"not": "a run input"})
    assert response.status_code == 422


async def test_run_streams_protocol_frames(registry: AgentRegistry) -> None:
    app = build_test_app(registry.stream)
    async with (
        client_for(app) as client,
        client.stream("POST", URL, json=BODY) as response,
    ):
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        body = "".join([chunk async for chunk in response.aiter_text()])

    assert body.startswith('data: {"type":"start"}')
