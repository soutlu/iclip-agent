"""agent 运行端点的 HTTP 契约：权限门控、CSRF 防线、未注册 id、协议流、run 落库。

模型用官方 ``test``，因此本层无需任何厂商 SDK 或凭证。
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.config import ResolvedAgent, ResolvedSubAgent
from tests.helpers.agui import run_input, sse_events
from tests.integration_no_llm.conftest import (
    TEST_MODEL_NAME,
    register_and_login,
    set_roles_in_db,
)

AGENT_ID = "storyboard"
URL = f"/agents/{AGENT_ID}/chat"
BODY = run_input()


def write_spec(root: Path, name: str) -> Path:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "agent.yaml"
    path.write_text("", encoding="utf-8")
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
            model=TEST_MODEL_NAME,
            skills=None,
            capabilities=(),
            subagents=(
                ResolvedSubAgent(
                    name="shot-writer",
                    spec=child,
                    instructions=None,
                    model=TEST_MODEL_NAME,
                    skills=None,
                    capabilities=(),
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

    assert sse_events(body)[0]["type"] == "RUN_STARTED"
    # 子代理已装配：派活工具对模型可见。
    assert "delegate_task" in body


async def test_run_is_recorded_in_postgres(client: httpx.AsyncClient, pg_url: str) -> None:
    """走完整 HTTP 路径的一次运行必须在 agent_runtime 留下 run 与步骤事件。"""

    await login_as_editor(client, pg_url)
    conversation_id = "conversation-persisted"

    body = run_input(thread_id=conversation_id)
    async with client.stream("POST", URL, json=body) as response:
        assert response.status_code == 200
        async for _ in response.aiter_text():
            pass

    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            # agent_runtime 不参与 conftest 的 TRUNCATE（那只清 iclip 的身份表），
            # 复用同一个测试库时旧 run 会留着——只取最新一条，不断言总数。
            run_id = (
                await conn.execute(
                    text(
                        "SELECT run_id FROM agent_runtime.runs "
                        "WHERE conversation_id = :cid AND agent_name = :name "
                        "ORDER BY started_at DESC LIMIT 1"
                    ),
                    {"cid": conversation_id, "name": AGENT_ID},
                )
            ).scalar_one()
            kinds = (
                (
                    await conn.execute(
                        text(
                            "SELECT kind FROM agent_runtime.events "
                            "WHERE run_id = :run_id ORDER BY seq"
                        ),
                        {"run_id": run_id},
                    )
                )
                .scalars()
                .all()
            )
    finally:
        await engine.dispose()

    assert run_id.startswith(f"{AGENT_ID}-")
    assert kinds[0] == "run_started"
