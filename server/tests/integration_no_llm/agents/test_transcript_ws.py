"""订阅连接走一遍真链路：握手、订阅、推送、重订阅。

**这一条最要紧的断言是「发出去的字节长什么样」。** 客户端的 reducer 是照抄来的 zod，形状对不上
就是 safeParse 失败——不报错、不重试，界面永远停在空白。REST 那侧由 FastAPI 按别名序列化，
不会犯这个错；WS 是手工发的，只有这里看得住。

全程同步 TestClient（HTTP 与 WS 同一事件循环）。
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from iclip.config import ResolvedAgent
from tests.integration_no_llm.conftest import TEST_MODEL_NAME, set_roles_in_db

AGENT_ID = "storyboard"
PASSWORD = "password-123"


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


def _sign_in(tc: TestClient, pg_url: str) -> None:
    created = tc.post(
        "/auth/register",
        json={"email": "luke@example.com", "password": PASSWORD, "username": "luke"},
    )
    assert created.status_code == 201, created.text
    asyncio.run(set_roles_in_db(pg_url, "luke@example.com", ["editor"]))
    assert (
        tc.post("/auth/login", data={"username": "luke", "password": PASSWORD}).status_code == 204
    )


def _open_conversation(tc: TestClient) -> str:
    created = tc.post("/conversations", json={"agentId": AGENT_ID})
    assert created.status_code == 201, created.text
    return str(created.json()["conversation"]["id"])


def _subscribe(ws: Any, conversation_id: str, *, since: int | None = None) -> None:
    ws.send_json({"type": "client_hello", "id": "h1", "payload": {"client_id": conversation_id}})
    payload: dict[str, Any] = {
        "session_id": conversation_id,
        "transcript": {"main": "delta"},
    }
    if since is not None:
        payload["transcript_since"] = {"main": since}
    ws.send_json({"type": "subscribe_v2", "id": "s1", "payload": payload})


def _until(ws: Any, kind: str, *, tries: int = 40) -> dict[str, Any]:
    """收到某一类帧为止。中间会夹着 ack 与心跳，跳过它们。"""

    for _ in range(tries):
        frame: dict[str, Any] = ws.receive_json()
        if frame.get("type") == kind:
            return frame
    raise AssertionError(f"没收到 {kind}")


def test_subscribe_then_receive_ops(ws_agent_app: FastAPI, pg_url: str) -> None:
    """订阅拿到 reset，发一条消息之后拿到这一轮的操作。"""

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)
        conversation_id = _open_conversation(tc)

        with tc.websocket_connect(f"/conversations/{conversation_id}/ws") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "server_hello"
            assert hello["payload"]["heartbeat_ms"] > 0

            _subscribe(ws, conversation_id)
            reset = _until(ws, "transcript.reset")
            # 客户端就是按这两个字段取内容的，少一个整帧被丢。
            assert reset["session_id"] == conversation_id
            assert reset["payload"]["agent_id"] == "main"
            # seq 在协议里标成可选，我们必须带：客户端拿它无条件覆写本地水位。
            assert isinstance(reset["payload"]["seq"], int)
            # 历史走 REST 分页，这一帧的 items 恒空。
            assert reset["payload"]["snapshot"]["items"] == []

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_ws", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text

            ops = _until(ws, "transcript.ops")
            assert ops["payload"]["seq"] >= 1
            assert ops["payload"]["ops"]

            # 帧里嵌的实体必须按别名出去。写成 turn_id 的话客户端整帧丢掉且不报错，
            # 界面永远停在空白——这颗钉子就是防它。
            text = json.dumps(ops, ensure_ascii=False)
            assert "turn_id" not in text
            assert "step_id" not in text
            assert "frame_id" not in text

            # 等这一轮跑完再断开：运行不绑在连接上，跑着的时候拆连接是另一件事（下一条测）。
            for _ in range(200):
                queue = tc.get(f"/conversations/{conversation_id}/prompts").json()
                if queue["active"] is None and not queue["queued"]:
                    break
                time.sleep(0.02)


def test_resubscribing_with_a_stale_watermark_gets_a_reset(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """手上的水位比服务端还大（上一代编号），只能整页重来，不能补批。"""

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)
        conversation_id = _open_conversation(tc)

        with tc.websocket_connect(f"/conversations/{conversation_id}/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            _subscribe(ws, conversation_id, since=99999)
            assert _until(ws, "transcript.reset")["payload"]["seq"] == 0


def test_cross_origin_upgrade_is_refused(ws_agent_app: FastAPI, pg_url: str) -> None:
    """WS 升级不受 CORS 约束、浏览器照常带 cookie，所以 Origin 得自己校验。"""

    from starlette.websockets import WebSocketDisconnect

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)
        conversation_id = _open_conversation(tc)

        with (
            pytest.raises(WebSocketDisconnect) as refused,
            tc.websocket_connect(
                f"/conversations/{conversation_id}/ws",
                headers={"origin": "https://evil.example"},
            ),
        ):
            pass  # 连接根本不该成立

    assert refused.value.code == 1008
