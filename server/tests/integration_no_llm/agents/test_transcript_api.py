"""使用 TestModel 验证 transcript 的 HTTP 权限、消息受理、分页和补发契约。"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
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


async def _sign_in(client: httpx.AsyncClient, pg_url: str) -> str:

    user_id = await register_and_login(client)
    await set_roles_in_db(pg_url, "luke@example.com", ["editor"])
    return user_id


async def _materials(pg_url: str, namespace: str) -> list[tuple[str, str]]:

    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text(
                        "SELECT url, kind FROM agent_runtime.materials "
                        "WHERE namespace = :ns ORDER BY url"
                    ),
                    {"ns": namespace},
                )
            ).all()
    finally:
        await engine.dispose()
    return [(row[0], row[1]) for row in rows]


async def test_anonymous_cannot_send(app: FastAPI) -> None:

    async with make_client(app) as client:
        sent = await client.post(
            "/conversations/00000000-0000-0000-0000-000000000000/prompts",
            json={"prompt_id": "prm_anon", "content": [{"type": "text", "text": "走"}]},
        )
    assert sent.status_code == 401


async def test_sending_to_someone_elses_conversation_is_not_found(
    app: FastAPI, pg_url: str
) -> None:

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        sent = await client.post(
            "/conversations/00000000-0000-0000-0000-000000000000/prompts",
            json={"prompt_id": "prm_other", "content": [{"type": "text", "text": "走"}]},
        )
    assert sent.status_code == 404


async def test_send_then_read_it_back(app: FastAPI, pg_url: str) -> None:

    async with make_client(app) as client:
        await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        sent = await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={"prompt_id": "prm_read", "content": [{"type": "text", "text": "写三个镜头"}]},
        )
        assert sent.status_code == 200, sent.text
        assert sent.json()["status"] == "running"

        await settled(client, conversation_id)
        page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()

    assert page["agent_id"] == "main"  # 信封字段为 snake_case，实体字段为 camelCase。
    assert page["has_more"] is False
    assert [turn["turnId"] for turn in page["items"]] == ["t1"]
    assert page["items"][0]["content"] == [{"type": "text", "text": "写三个镜头"}]
    assert page["items"][0]["state"] == "completed"
    assert page["items"][0]["steps"][0]["frames"][0]["kind"] == "text"


async def test_second_prompt_queues_while_the_first_runs(app: FastAPI, pg_url: str) -> None:

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


async def test_attachments_land_in_the_material_ledger(app: FastAPI, pg_url: str) -> None:
    """消息受理时须登记附件及类型，使后续工具的素材校验认可用户输入。"""

    image = "https://cdn.test/style.jpg"
    video = "https://cdn.test/ref.mp4"
    async with make_client(app) as client:
        user_id = await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        sent = await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={
                "prompt_id": "prm_media",
                "content": [
                    {"type": "text", "text": "看这两个"},
                    {"type": "image", "source": {"kind": "url", "url": image}},
                    {"type": "video", "source": {"kind": "url", "url": video}},
                ],
            },
        )
        assert sent.status_code == 200, sent.text
        await settled(client, conversation_id)

    assert await _materials(pg_url, f"{user_id}/{conversation_id}") == [
        (video, "video"),
        (image, "image"),
    ]


async def test_a_text_only_prompt_records_nothing(app: FastAPI, pg_url: str) -> None:
    async with make_client(app) as client:
        user_id = await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={"prompt_id": "prm_plain", "content": [{"type": "text", "text": "走"}]},
        )
        await settled(client, conversation_id)

    assert await _materials(pg_url, f"{user_id}/{conversation_id}") == []


async def test_an_attachment_that_is_not_http_is_refused(app: FastAPI, pg_url: str) -> None:
    """台账地址会用于工具外呼，仅接受 HTTP(S)。"""

    async with make_client(app) as client:
        user_id = await _sign_in(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        sent = await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={
                "prompt_id": "prm_bad",
                "content": [
                    {"type": "image", "source": {"kind": "url", "url": "file:///etc/passwd"}}
                ],
            },
        )

    assert sent.status_code == 422
    assert await _materials(pg_url, f"{user_id}/{conversation_id}") == []


async def test_catchup_reports_whether_it_got_everything(app: FastAPI, pg_url: str) -> None:

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
    )
    assert stale["complete"] is False
