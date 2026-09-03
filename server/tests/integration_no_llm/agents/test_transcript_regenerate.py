"""「重新生成」端点：末轮重放、忙与非末轮的 409、找不到的 404、轮 id 不合法的 422。

寻址用协议里的轮 id（``t{N}``），不是 prompt id——轮头部本来就没有 prompt id 可给。
模型用官方 ``FunctionModel`` 替身并刻意放慢半秒，让「对话正忙」是一个确定的时间窗，不靠撞。
"""

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
                # content 是纯 str 或一串 UserContent（引擎那一侧 ``model_prompt`` 出的就是一串）。
                items = [part.content] if isinstance(part.content, str) else list(part.content)
                texts = [item for item in items if isinstance(item, str)]
                if texts:
                    return "\n".join(texts)
    return ""


@pytest.fixture
def models() -> dict[str, FunctionModel]:
    """慢半拍的替身模型：每次请求先睡一会儿再答，留出一段确定的「正忙」窗口。

    引擎走流式请求，所以替身必须给 ``stream_function``（只给 ``function`` 的那一版，跑到
    模型那一步就报错，一轮都跑不成）。
    """

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


async def test_regenerate_replays_the_last_turn(app: FastAPI, pg_url: str) -> None:
    """对末轮重新生成：历史截回那一轮之前，原内容重跑，轮号复用，旧 run 的行留在库里。"""

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_r1", "第一问")
        await settled(client, conversation_id)
        await _send(client, conversation_id, "prm_r2", "第二问")
        await settled(client, conversation_id)

        replayed = await client.post(f"/conversations/{conversation_id}/turns/t2:regenerate")
        assert replayed.status_code == 200, replayed.text
        assert replayed.json()["promptId"] != "prm_r2"  # 重跑那条的 id 由服务端另铸
        assert replayed.json()["status"] == "running"
        assert replayed.json()["content"] == [{"type": "text", "text": "第二问"}]
        await settled(client, conversation_id)
        page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()

    # 重跑顶替了旧末轮：还是两轮、轮号复用 t2，内容是新跑出来的那句。
    assert [turn["turnId"] for turn in page["items"]] == ["t1", "t2"]
    assert [turn["content"] for turn in page["items"]] == [
        [{"type": "text", "text": "第一问"}],
        [{"type": "text", "text": "第二问"}],
    ]
    assert page["items"][1]["steps"][0]["frames"][0]["text"] == "答：第二问"

    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            runs = (
                await conn.execute(
                    text("SELECT count(*) FROM agent_runtime.runs WHERE conversation_id = :cid"),
                    {"cid": conversation_id},
                )
            ).scalar_one()
    finally:
        await engine.dispose()
    assert runs == 3  # 原来两轮的 run 留在库里，重跑是第三次


async def test_regenerate_while_busy_is_conflict(app: FastAPI, pg_url: str) -> None:
    """对话正忙不许重新生成：在跑的那一轮不行，排着的那条占着的下一轮位置也不行。"""

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_busy1", "问")
        await _send(client, conversation_id, "prm_busy2", "再问")  # 模型睡着，这条一定排上队

        # 这一刻第一条在跑、第二条排着，无论指哪一轮重新生成都是冲突。
        refused_running = await client.post(f"/conversations/{conversation_id}/turns/t1:regenerate")
        refused_queued = await client.post(f"/conversations/{conversation_id}/turns/t2:regenerate")
        await settled(client, conversation_id)

    assert refused_running.status_code == 409
    assert refused_queued.status_code == 409


async def test_regenerate_an_older_turn_is_conflict(app: FastAPI, pg_url: str) -> None:
    """只能重新生成最后一轮：对话空着，但指的是更早的一轮、或超出现有轮数。"""

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
    """末轮在库里找不到对应的消息记录（行没了），404。"""

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

    assert missing.status_code == 404


async def test_regenerate_in_someone_elses_conversation_is_not_found(
    app: FastAPI, pg_url: str
) -> None:
    """对话是别人的，拿到它底下来重新生成，404——不透露它存在。"""

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
    """轮 id 不是 ``t{N}`` 的形状（N 从 1 起），422。"""

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_shape", "问")
        await settled(client, conversation_id)

        not_a_turn = await client.post(f"/conversations/{conversation_id}/turns/abc:regenerate")
        zero = await client.post(f"/conversations/{conversation_id}/turns/t0:regenerate")

    assert not_a_turn.status_code == 422
    assert zero.status_code == 422
