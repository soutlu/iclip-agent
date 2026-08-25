"""刷新之后拿回这段对话：媒体回到前端形状，工具结果里的图片字节留在服务端。

前端刷新或重新登录后手里什么都没有，这个端点是它唯一的历史来源。所以这里验的是
一整趟往返：带附件发一次 → 落库 → 读回来的形状能不能直接渲染、也能不能原样再发。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from iclip.config import ResolvedAgent
from tests.helpers.agui import run_input
from tests.integration_no_llm.conftest import (
    TEST_MODEL_NAME,
    make_client,
    new_conversation,
    register_and_login,
    set_roles_in_db,
)

AGENT_ID = "storyboard"
CHAT_URL = f"/agents/{AGENT_ID}/chat"
OSS = "https://bucket.oss-cn-hangzhou.aliyuncs.com"
VIDEO_URL = f"{OSS}/ref.mp4"
IMAGE_URL = f"{OSS}/style.jpg"


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


async def login_as_editor(
    client: httpx.AsyncClient, pg_url: str, *, username: str = "luke"
) -> None:
    await register_and_login(client, username=username, email=f"{username}@example.com")
    await set_roles_in_db(pg_url, f"{username}@example.com", ["editor"])


async def run_once(
    client: httpx.AsyncClient, conversation_id: str, content: list[dict[str, Any]]
) -> None:
    body = run_input(thread_id=conversation_id, content=content)
    async with client.stream("POST", CHAT_URL, json=body) as response:
        assert response.status_code == 200, await response.aread()
        async for _ in response.aiter_text():
            pass


async def test_history_comes_back_as_media_parts_not_tags(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """发出去是 part，读回来还是 part：中间那副给模型看的 tag 形状不外露。"""

    await login_as_editor(client, pg_url)
    conversation_id = await new_conversation(client, AGENT_ID)
    await run_once(
        client,
        conversation_id,
        [
            {"type": "text", "text": "参考这个片子"},
            {
                "type": "video",
                "source": {"type": "url", "value": VIDEO_URL, "mimeType": "video/mp4"},
                "metadata": {"filename": "ref.mp4"},
            },
            {
                "type": "image",
                "source": {"type": "url", "value": IMAGE_URL, "mimeType": "image/jpeg"},
            },
        ],
    )

    read = await client.get(f"/conversations/{conversation_id}/messages")

    assert read.status_code == 200, read.text
    messages = read.json()["messages"]
    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert messages[0]["content"] == [
        {"type": "text", "text": "参考这个片子"},
        {
            "type": "video",
            "source": {"type": "url", "value": VIDEO_URL},
            "metadata": {"filename": "ref.mp4"},
        },
        # 缩略图那份不回来：它是喂模型的，前端要的是原图。
        {"type": "image", "source": {"type": "url", "value": IMAGE_URL}},
    ]


async def test_history_is_empty_before_the_first_run(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    conversation_id = await new_conversation(client, AGENT_ID)

    read = await client.get(f"/conversations/{conversation_id}/messages")

    assert (read.status_code, read.json()) == (200, {"messages": []})


async def test_another_users_history_is_invisible(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """别人的对话读不到，而且是 404——403 会告诉他这个 id 确实有人在用。"""

    await login_as_editor(client, pg_url)
    conversation_id = await new_conversation(client, AGENT_ID)
    await run_once(client, conversation_id, [{"type": "text", "text": "我的"}])

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mallory")
        read = await other.get(f"/conversations/{conversation_id}/messages")

    assert read.status_code == 404
