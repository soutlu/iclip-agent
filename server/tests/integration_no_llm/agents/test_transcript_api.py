"""transcript 对外面的 HTTP 契约：权限门控、发消息、分页、补批。

模型用官方 ``test``，因此本层无需任何厂商 SDK 或凭证。
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

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


async def _sign_in(client: httpx.AsyncClient, pg_url: str) -> None:
    """注册并拿到能跑 agent 的角色。"""

    await register_and_login(client)
    await set_roles_in_db(pg_url, "luke@example.com", ["editor"])


async def test_anonymous_cannot_send(app: FastAPI) -> None:
    """没登录发不了消息。"""

    async with make_client(app) as client:
        sent = await client.post(
            "/conversations/00000000-0000-0000-0000-000000000000/prompts",
            json={"prompt_id": "prm_anon", "content": [{"type": "text", "text": "走"}]},
        )
    assert sent.status_code == 401


async def test_sending_to_someone_elses_conversation_is_not_found(
    app: FastAPI, pg_url: str
) -> None:
    """编一个会话 id 发过来，答 404，不透露它存不存在。"""

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        sent = await client.post(
            "/conversations/00000000-0000-0000-0000-000000000000/prompts",
            json={"prompt_id": "prm_other", "content": [{"type": "text", "text": "走"}]},
        )
    assert sent.status_code == 404


async def test_send_then_read_it_back(app: FastAPI, pg_url: str) -> None:
    """发一条消息，跑完之后读得回来：一轮、带 prompt、带正文块。"""

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        sent = await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={"prompt_id": "prm_read", "content": [{"type": "text", "text": "写三个镜头"}]},
        )
        assert sent.status_code == 200, sent.text
        assert sent.json()["status"] == "running"  # 这段对话空着，就地开跑

        await settled(client, conversation_id)
        page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()

    assert page["agent_id"] == "main"  # 信封是 snake_case，实体是 camelCase
    assert page["has_more"] is False
    assert [turn["turnId"] for turn in page["items"]] == ["t1"]
    assert page["items"][0]["content"] == [{"type": "text", "text": "写三个镜头"}]
    assert page["items"][0]["state"] == "completed"
    assert page["items"][0]["steps"][0]["frames"][0]["kind"] == "text"


async def test_second_prompt_queues_while_the_first_runs(app: FastAPI, pg_url: str) -> None:
    """一段对话同时只跑一条，第二条答 queued。"""

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        first = await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={"prompt_id": "prm_q1", "content": [{"type": "text", "text": "一"}]},
        )
        second = await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={"prompt_id": "prm_q2", "content": [{"type": "text", "text": "二"}]},
        )
        assert first.json()["status"] == "running"
        assert second.json()["status"] == "queued"
        await settled(client, conversation_id)


async def test_catchup_reports_whether_it_got_everything(app: FastAPI, pg_url: str) -> None:
    """补批要说清楚有没有取全；水位来自上一代编号时答 ``complete: false``。"""

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={"prompt_id": "prm_catch", "content": [{"type": "text", "text": "走"}]},
        )
        await settled(client, conversation_id)

        caught = (
            await client.get(
                f"/conversations/{conversation_id}/transcript/ops", params={"since_seq": 0}
            )
        ).json()
        stale = (
            await client.get(
                f"/conversations/{conversation_id}/transcript/ops", params={"since_seq": 99999}
            )
        ).json()

    assert caught["complete"] is True
    assert [batch["seq"] for batch in caught["batches"]] == list(
        range(1, len(caught["batches"]) + 1)
    )  # 批次号从 1 起，连续
    assert stale["complete"] is False  # 手上的号比服务端还大，只能整页重拉
