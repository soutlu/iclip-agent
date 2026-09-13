"""WS 集成测试共用的动作：登录、开对话、订阅、按类型等帧、按轮收操作。"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from starlette.testclient import TestClient

from tests.integration_no_llm.conftest import set_roles_in_db

AGENT_ID = "storyboard"
PASSWORD = "password-123"
SESSION_COOKIE = "iclip_session"


def sign_in(tc: TestClient, pg_url: str) -> None:
    created = tc.post(
        "/auth/register",
        json={"email": "luke@example.com", "password": PASSWORD, "username": "luke"},
    )
    assert created.status_code == 201, created.text
    asyncio.run(set_roles_in_db(pg_url, "luke@example.com", ["editor"]))
    assert (
        tc.post("/auth/login", data={"username": "luke", "password": PASSWORD}).status_code == 204
    )


def sign_in_as(
    tc: TestClient, pg_url: str, *, username: str, roles: tuple[str, ...]
) -> dict[str, str]:
    """注册、授角色、登录，返回只带这个人会话 cookie 的请求头。

    随后清空客户端的 cookie 罐，同一个 TestClient 就能替几个人分别发请求、开连接。
    不开第二个 TestClient：那是第二个事件循环，会碰同一个进程内的连接集合。"""

    email = f"{username}@example.com"
    created = tc.post(
        "/auth/register", json={"email": email, "password": PASSWORD, "username": username}
    )
    assert created.status_code == 201, created.text
    asyncio.run(set_roles_in_db(pg_url, email, list(roles)))
    assert (
        tc.post("/auth/login", data={"username": username, "password": PASSWORD}).status_code == 204
    )
    token = tc.cookies.get(SESSION_COOKIE)
    assert token, "登录没有种下会话 cookie"
    tc.cookies.clear()
    return {"cookie": f"{SESSION_COOKIE}={token}"}


def open_conversation(tc: TestClient, headers: Mapping[str, str] | None = None) -> str:
    created = tc.post("/conversations", json={"agentId": AGENT_ID}, headers=headers)
    assert created.status_code == 201, created.text
    return str(created.json()["conversation"]["id"])


def subscribe(
    ws: Any,
    conversation_id: str,
    *,
    since: int | None = None,
    frame_id: str = "s1",
    grade: str = "delta",
) -> None:
    payload: dict[str, Any] = {
        "session_id": conversation_id,
        "transcript": {"main": grade},
    }
    if since is not None:
        payload["transcript_since"] = {"main": since}
    ws.send_json({"type": "subscribe_v2", "id": frame_id, "payload": payload})


def until(ws: Any, kind: str, *, tries: int = 40) -> dict[str, Any]:
    """等待指定帧类型，跳过期间的 ack 和心跳。"""

    for _ in range(tries):
        frame: dict[str, Any] = ws.receive_json()
        if frame.get("type") == kind:
            return frame
    raise AssertionError(f"没收到 {kind}")


def drain_turn(ws: Any, *, tries: int = 40) -> list[dict[str, Any]]:
    """按轮终态收集操作；低粒度会过滤批次，不能等待固定帧数。"""

    collected: list[dict[str, Any]] = []
    for _ in range(tries):
        frame = ws.receive_json()
        if frame.get("type") != "transcript.ops":
            continue
        ops: list[dict[str, Any]] = frame["payload"]["ops"]
        collected.extend(ops)
        if any(op["op"] == "turn.upsert" and op["turn"]["state"] != "running" for op in ops):
            return collected
    raise AssertionError("这一轮没等到结束")


__all__ = [
    "AGENT_ID",
    "PASSWORD",
    "SESSION_COOKIE",
    "drain_turn",
    "open_conversation",
    "sign_in",
    "sign_in_as",
    "subscribe",
    "until",
]
