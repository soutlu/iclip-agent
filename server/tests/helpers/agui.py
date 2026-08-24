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
) -> dict[str, Any]:
    """一条最小的合法请求体。

    ``thread_id`` 是会话 id：同一个值代表同一段对话，服务端据此把多次运行
    归到一起。
    """

    return {
        "threadId": thread_id,
        "runId": run_id,
        "state": {},
        "messages": [{"id": "m1", "role": "user", "content": text}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def run_input_bytes(**kwargs: Any) -> bytes:
    """同上，但给出 JSON 字节——harness 那层的入口直接收 bytes。"""

    return json.dumps(run_input(**kwargs)).encode("utf-8")
