"""agent 运行端点的 HTTP 契约：权限门控、CSRF 防线、未注册 id、协议流、run 落库。

模型用官方 ``test``，因此本层无需任何厂商 SDK 或凭证。
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.config import ResolvedAgent, ResolvedSubAgent
from tests.helpers.agui import run_input, sse_events
from tests.integration_no_llm.conftest import (
    TEST_MODEL_NAME,
    make_client,
    new_conversation,
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
    body = run_input(thread_id=await new_conversation(client, AGENT_ID))

    async with client.stream("POST", URL, json=body) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        body = "".join([chunk async for chunk in response.aiter_text()])

    assert sse_events(body)[0]["type"] == "RUN_STARTED"
    # 子代理已装配：派活工具对模型可见。
    assert "delegate_task" in body


async def test_run_is_recorded_in_postgres(client: httpx.AsyncClient, pg_url: str) -> None:
    """走完整 HTTP 路径的一次运行必须在 agent_runtime 留下 run 与步骤事件。"""

    await login_as_editor(client, pg_url)
    conversation_id = await new_conversation(client, AGENT_ID)

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


async def test_unknown_conversation_is_404(client: httpx.AsyncClient, pg_url: str) -> None:
    """会话 id 由服务端发放：客户端自己编一个，发消息就被拒。"""

    await login_as_editor(client, pg_url)
    response = await client.post(URL, json=run_input(thread_id="conversation-i-made-up"))
    assert response.status_code == 404


async def test_another_users_conversation_is_404(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """别人的会话一律当作不存在，不返 403——那会泄露这个 id 确实有人在用。"""

    await login_as_editor(client, pg_url)
    conversation_id = await new_conversation(client, AGENT_ID)

    async with make_client(app) as other:
        await register_and_login(other, username="mallory", email="mallory@example.com")
        await set_roles_in_db(pg_url, "mallory@example.com", ["editor"])
        response = await other.post(URL, json=run_input(thread_id=conversation_id))

    assert response.status_code == 404


async def test_run_is_recorded_on_the_conversation(client: httpx.AsyncClient, pg_url: str) -> None:
    """跑过一次之后，对话上记着最近一次运行的 id——刷新页面靠它接回那条流。"""

    await login_as_editor(client, pg_url)
    conversation_id = await new_conversation(client, AGENT_ID)

    async with client.stream(
        "POST", URL, json=run_input(thread_id=conversation_id, run_id="run-latest")
    ) as response:
        assert response.status_code == 200
        async for _ in response.aiter_text():
            pass

    listed = await client.get("/conversations/search")
    assert [item["lastRunId"] for item in listed.json()["items"]] == ["run-latest"]

    # 客户端铸造的那个 id 也被盖进了消息里：库里那条运行记录的主键跟它不是一个东西，
    # 没有这一层，用户报「刚才那条回复不对」就没法从它查回落库的事实。
    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            messages = (
                await conn.execute(
                    text(
                        "SELECT s.messages FROM agent_runtime.snapshots s "
                        "WHERE s.conversation_id = :cid ORDER BY s.seq DESC LIMIT 1"
                    ),
                    {"cid": conversation_id},
                )
            ).scalar_one()
    finally:
        await engine.dispose()

    assert "run-latest" in messages


async def test_conversation_id_must_match_byte_for_byte(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """大写写法解析出的是同一个 UUID，但下游用的是原样字符串——放行它会长出第二个
    工作区和第二条事件流，而删除对话时又碰不到它们。"""

    await login_as_editor(client, pg_url)
    conversation_id = await new_conversation(client, AGENT_ID)

    response = await client.post(URL, json=run_input(thread_id=conversation_id.upper()))
    assert response.status_code == 404
