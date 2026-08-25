"""AG-UI 请求体构造器。

AG-UI 的请求体有七个必填字段，少任何一个都是 422。这里集中造一份，
省得每层测试各抄一遍，也省得协议加字段时要改好几处。
"""

from __future__ import annotations

import json
from typing import Any


def run_input(
    *,
    thread_id: str = "conversation-1",
    run_id: str = "run-1",
    text: str = "hi",
    content: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """一条最小的合法请求体。

    ``thread_id`` 是会话 id：同一个值代表同一段对话，服务端据此把多次运行
    归到一起。给了 ``content`` 就用它当这条用户消息的内容（带附件的形状），
    否则是纯文本 ``text``。
    """

    return {
        "threadId": thread_id,
        "runId": run_id,
        "state": {},
        "messages": [{"id": "m1", "role": "user", "content": content if content else text}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def run_input_bytes(**kwargs: Any) -> bytes:
    """同上，但给出 JSON 字节——harness 那层的入口直接收 bytes。"""

    return json.dumps(run_input(**kwargs)).encode("utf-8")


def sse_events(body: str) -> list[dict[str, Any]]:
    """从 SSE 正文里取出事件。"""

    return [
        json.loads(block.split("data: ", 1)[1]) for block in body.split("\n\n") if "data: " in block
    ]


def sse_cursors(body: str) -> list[str]:
    """从 SSE 正文里取出每帧的位置（客户端断线后要报回来的那个值）。"""

    return [line.removeprefix("id: ") for line in body.splitlines() if line.startswith("id: ")]
