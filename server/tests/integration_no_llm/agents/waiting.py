"""等待会话运行结束；请求在 prompt 受理后即返回，不代表结果已持久化。"""

from __future__ import annotations

import asyncio

import httpx


async def settled(client: httpx.AsyncClient, conversation_id: str, *, tries: int = 200) -> None:
    for _ in range(tries):
        queue = (await client.get(f"/conversations/{conversation_id}/prompts")).json()
        if queue["active"] is None and not queue["queued"]:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("这段对话没跑完")
