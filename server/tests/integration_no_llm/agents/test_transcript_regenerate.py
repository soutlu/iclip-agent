"""验证重新生成的末轮重放、幂等和 HTTP 错误契约；寻址使用 t{N} 轮 id。"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from pydantic_ai.messages import ModelMessage, ModelRequest, UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.config import ResolvedAgent
from tests.integration_no_llm.agents.waiting import settled
from tests.integration_no_llm.conftest import (
    TEST_MODEL_NAME,
    make_client,
    new_conversation,
    register_and_login,
    set_roles_in_db,
)

AGENT_ID = "storyboard"


@pytest.fixture
def agent_declarations(tmp_path: Path) -> tuple[ResolvedAgent, ...]:
    folder = tmp_path / AGENT_ID
    folder.mkdir(parents=True, exist_ok=True)
    spec = folder / "agent.yaml"
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


def _last_user_text(messages: list[ModelMessage]) -> str:
    for message in reversed(messages):
        if isinstance(message, ModelRequest):
            for part in message.parts:
                if not isinstance(part, UserPromptPart):
                    continue
                items = [part.content] if isinstance(part.content, str) else list(part.content)
                texts = [item for item in items if isinstance(item, str)]
                if texts:
                    return "\n".join(texts)
    return ""


@pytest.fixture
def models() -> dict[str, FunctionModel]:
    """延迟响应以覆盖对话忙碌窗口；提供 stream_function 以适配流式运行。"""

    async def reply(messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
        await asyncio.sleep(0.5)
        yield f"答：{_last_user_text(messages)}"

    return {TEST_MODEL_NAME: FunctionModel(stream_function=reply)}


async def _sign_in(client: httpx.AsyncClient, pg_url: str) -> None:
    await register_and_login(client)
    await set_roles_in_db(pg_url, "luke@example.com", ["editor"])


async def _send(
    client: httpx.AsyncClient, conversation_id: str, prompt_id: str, text_: str
) -> None:
    sent = await client.post(
        f"/conversations/{conversation_id}/prompts",
        json={"prompt_id": prompt_id, "content": [{"type": "text", "text": text_}]},
    )
    assert sent.status_code == 200, sent.text


async def _run_count(pg_url: str, conversation_id: str) -> int:
    """统计持久化 run 数；重新生成保留旧 run 并新增记录。"""

    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            return (
                await conn.execute(
                    text("SELECT count(*) FROM agent_runtime.runs WHERE conversation_id = :cid"),
                    {"cid": conversation_id},
                )
            ).scalar_one()
    finally:
        await engine.dispose()


async def test_regenerate_replays_the_last_turn(app: FastAPI, pg_url: str) -> None:

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_r1", "第一问")
        await settled(client, conversation_id)
        await _send(client, conversation_id, "prm_r2", "第二问")
        await settled(client, conversation_id)

        replayed = await client.post(f"/conversations/{conversation_id}/turns/t2:regenerate")
        assert replayed.status_code == 200, replayed.text
        assert replayed.json()["promptId"] != "prm_r2"
        assert replayed.json()["status"] == "running"
        assert replayed.json()["content"] == [{"type": "text", "text": "第二问"}]
        await settled(client, conversation_id)
        page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()

    assert [turn["turnId"] for turn in page["items"]] == ["t1", "t2"]
    assert [turn["content"] for turn in page["items"]] == [
        [{"type": "text", "text": "第一问"}],
        [{"type": "text", "text": "第二问"}],
    ]
    assert page["items"][1]["steps"][0]["frames"][0]["text"] == "答：第二问"

    assert await _run_count(pg_url, conversation_id) == 3


async def test_regenerate_with_new_content_replays_the_edited_message(
    app: FastAPI, pg_url: str
) -> None:

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_e1", "第一问")
        await settled(client, conversation_id)
        await _send(client, conversation_id, "prm_e2", "第二问")
        await settled(client, conversation_id)

        edited = await client.post(
            f"/conversations/{conversation_id}/turns/t2:regenerate",
            json={"content": [{"type": "text", "text": "改口再问"}]},
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["content"] == [{"type": "text", "text": "改口再问"}]
        await settled(client, conversation_id)
        page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()

    assert [turn["turnId"] for turn in page["items"]] == ["t1", "t2"]
    assert [turn["content"] for turn in page["items"]] == [
        [{"type": "text", "text": "第一问"}],
        [{"type": "text", "text": "改口再问"}],
    ]
    assert page["items"][1]["steps"][0]["frames"][0]["text"] == "答：改口再问"
    assert await _run_count(pg_url, conversation_id) == 3


async def test_regenerating_twice_with_the_same_prompt_id_returns_the_first(
    app: FastAPI, pg_url: str
) -> None:
    """幂等请求认领须早于忙碌检查，避免重试被拒或重复截断末轮。"""

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_t1", "第一问")
        await settled(client, conversation_id)
        await _send(client, conversation_id, "prm_t2", "第二问")
        await settled(client, conversation_id)

        first = await client.post(
            f"/conversations/{conversation_id}/turns/t2:regenerate",
            json={"prompt_id": "prm_retry"},
        )
        again = await client.post(
            f"/conversations/{conversation_id}/turns/t2:regenerate",
            json={"prompt_id": "prm_retry"},
        )
        assert first.status_code == 200, first.text
        assert again.status_code == 200, again.text
        assert first.json()["promptId"] == "prm_retry"
        assert again.json()["promptId"] == "prm_retry"
        await settled(client, conversation_id)
        page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()

    assert [turn["turnId"] for turn in page["items"]] == ["t1", "t2"]
    assert await _run_count(pg_url, conversation_id) == 3


async def test_regenerate_with_empty_content_is_unprocessable(app: FastAPI, pg_url: str) -> None:

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_empty", "问")
        await settled(client, conversation_id)

        empty = await client.post(
            f"/conversations/{conversation_id}/turns/t1:regenerate", json={"content": []}
        )

    assert empty.status_code == 422


async def test_regenerate_while_busy_is_conflict(app: FastAPI, pg_url: str) -> None:

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_busy1", "问")
        await _send(client, conversation_id, "prm_busy2", "再问")

        refused_running = await client.post(f"/conversations/{conversation_id}/turns/t1:regenerate")
        refused_queued = await client.post(f"/conversations/{conversation_id}/turns/t2:regenerate")
        await settled(client, conversation_id)

    assert refused_running.status_code == 409
    assert refused_queued.status_code == 409


async def test_regenerate_an_older_turn_is_conflict(app: FastAPI, pg_url: str) -> None:

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_old", "第一问")
        await settled(client, conversation_id)
        await _send(client, conversation_id, "prm_new", "第二问")
        await settled(client, conversation_id)

        refused_older = await client.post(f"/conversations/{conversation_id}/turns/t1:regenerate")
        refused_beyond = await client.post(f"/conversations/{conversation_id}/turns/t3:regenerate")

    assert refused_older.status_code == 409
    assert refused_beyond.status_code == 409


async def test_regenerate_without_prompt_row_is_not_found(app: FastAPI, pg_url: str) -> None:

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_gone", "问")
        await settled(client, conversation_id)

        engine = create_async_engine(pg_url)
        try:
            async with engine.begin() as conn:
                await conn.execute(
                    text("DELETE FROM agent_runtime.agent_jobs WHERE conversation_id = :cid"),
                    {"cid": conversation_id},
                )
        finally:
            await engine.dispose()

        missing = await client.post(f"/conversations/{conversation_id}/turns/t1:regenerate")
        page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()

    assert missing.status_code == 404
    assert [turn["content"] for turn in page["items"]] == [[{"type": "text", "text": "问"}]]


async def test_regenerate_in_someone_elses_conversation_is_not_found(
    app: FastAPI, pg_url: str
) -> None:
    """他人会话返回 404，避免泄漏资源存在性。"""

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        mine = await new_conversation(client, AGENT_ID)
        await _send(client, mine, "prm_mine", "问")
        await settled(client, mine)

        async with make_client(app) as other:
            await register_and_login(other, username="max", email="max@example.com")
            await set_roles_in_db(pg_url, "max@example.com", ["editor"])
            crossed = await other.post(f"/conversations/{mine}/turns/t1:regenerate")

    assert crossed.status_code == 404


async def test_regenerate_with_a_malformed_turn_id_is_unprocessable(
    app: FastAPI, pg_url: str
) -> None:

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_shape", "问")
        await settled(client, conversation_id)

        not_a_turn = await client.post(f"/conversations/{conversation_id}/turns/abc:regenerate")
        zero = await client.post(f"/conversations/{conversation_id}/turns/t0:regenerate")

    assert not_a_turn.status_code == 422
    assert zero.status_code == 422
