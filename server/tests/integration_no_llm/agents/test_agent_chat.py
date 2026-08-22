"""agent 运行端点的 HTTP 契约：权限门控、CSRF 防线、未注册 id、协议流。

模型用官方 ``test``，因此本层无需任何厂商 SDK 或凭证。
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from iclip.config import ResolvedAgent, ResolvedSubAgent
from tests.integration_no_llm.conftest import register_and_login, set_roles_in_db

AGENT_ID = "storyboard"
URL = f"/agents/{AGENT_ID}/chat"
BODY = {
    "trigger": "submit-message",
    "id": "conversation-1",
    "messages": [{"id": "m1", "role": "user", "parts": [{"type": "text", "text": "hi"}]}],
}


def write_spec(root: Path, name: str) -> Path:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "agent.yaml"
    path.write_text("model: test\n", encoding="utf-8")
    return path


@pytest.fixture
def agent_declarations(tmp_path: Path) -> tuple[ResolvedAgent, ...]:
    parent = write_spec(tmp_path, AGENT_ID)
    child = write_spec(tmp_path, "shot-writer")
    return (
        ResolvedAgent(
            agent_id=AGENT_ID,
            spec=parent,
            instructions=None,
            subagents=(
                ResolvedSubAgent(
                    name="shot-writer",
                    spec=child,
                    instructions=None,
                    timeout_seconds=180,
                    max_calls=3,
                    on_failure=None,
                ),
            ),
        ),
    )


async def login_as_editor(client: httpx.AsyncClient, pg_url: str) -> None:
    await register_and_login(client)
    await set_roles_in_db(pg_url, "luke@example.com", ["editor"])


async def test_anonymous_is_rejected(client: httpx.AsyncClient) -> None:
    response = await client.post(URL, json=BODY)
    assert response.status_code == 401


async def test_viewer_lacks_agent_run(client: httpx.AsyncClient) -> None:
    await register_and_login(client)  # 密码注册默认 viewer，只有 agent:read
    response = await client.post(URL, json=BODY)
    assert response.status_code == 403
    assert "agent:run" in response.json()["detail"]


async def test_non_json_content_type_rejected(client: httpx.AsyncClient, pg_url: str) -> None:
    """CSRF 防线：免检 content-type 在读 body、派发运行之前就被挡掉。"""

    await login_as_editor(client, pg_url)
    response = await client.post(URL, content=b"{}", headers={"content-type": "text/plain"})
    assert response.status_code == 415


async def test_preflight_grants_nothing(client: httpx.AsyncClient) -> None:
    response = await client.request("OPTIONS", URL)
    assert response.status_code == 204
    assert "access-control-allow-origin" not in response.headers


async def test_unknown_agent_id_is_404(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)
    response = await client.post("/agents/ghost/chat", json=BODY)
    assert response.status_code == 404


async def test_malformed_body_is_422(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)
    response = await client.post(URL, json={"not": "a run input"})
    assert response.status_code == 422


async def test_run_streams_protocol_frames(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)

    async with client.stream("POST", URL, json=BODY) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        body = "".join([chunk async for chunk in response.aiter_text()])

    assert body.startswith('data: {"type":"start"}')
    # 子代理已装配：派活工具对模型可见。
    assert "delegate_task" in body
