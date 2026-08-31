"""等一段对话跑空。

运行不绑在发起它的那个请求上——请求收下 prompt 就返回——所以凡是要看运行结果的用例都得先等它
自己收尾。
"""

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
