"""Principal 的传输无关性：WebSocket 握手走同一信任点 + CSWSH Origin 规则。

全程使用同步 TestClient（HTTP 与 WS 同一事件循环）。
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, WebSocket
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from iclip.domains.identity.middleware import (
    websocket_origin_allowed,
    websocket_principal,
)

PASSWORD = "password-123"


def _install_ws_routes(app: FastAPI) -> None:
    @app.websocket("/ws-echo")
    async def ws_echo(websocket: WebSocket) -> None:
        principal = websocket_principal(websocket)
        if principal is None or not websocket_origin_allowed(
            websocket, ("https://allowed.example",)
        ):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        await websocket.send_json({"kind": principal.kind, "display": principal.display})
        await websocket.close()


def _register_and_login(tc: TestClient) -> str:
    created = tc.post(
        "/auth/register",
        json={"email": "luke@example.com", "password": PASSWORD, "username": "luke"},
    )
    assert created.status_code == 201, created.text
    assert (
        tc.post("/auth/login", data={"username": "luke", "password": PASSWORD}).status_code == 204
    )
    cookie = tc.cookies.get("iclip_session")
    assert cookie
    return cookie


def test_cookie_and_bearer_handshakes(ws_app: FastAPI) -> None:
    _install_ws_routes(ws_app)
    with TestClient(ws_app) as tc:
        cookie = _register_and_login(tc)
        key = tc.post("/api-keys", json={"name": "ws", "permissions": ["agent:read"]})
        assert key.status_code == 201, key.text
        token = key.json()["apiKey"]["token"]

        with tc.websocket_connect("/ws-echo", headers={"cookie": f"iclip_session={cookie}"}) as ws:
            assert ws.receive_json()["kind"] == "user"

        with tc.websocket_connect("/ws-echo", headers={"Authorization": f"Bearer {token}"}) as ws:
            payload = ws.receive_json()
            assert payload["kind"] == "api_key"
            assert payload["display"].endswith("#ws")


def test_anonymous_handshake_denied(ws_app: FastAPI) -> None:
    _install_ws_routes(ws_app)
    with TestClient(ws_app) as tc:
        with (
            pytest.raises(WebSocketDisconnect) as exc,
            tc.websocket_connect("/ws-echo") as ws,
        ):
            ws.receive_json()
        assert exc.value.code == 1008


def test_origin_rules(ws_app: FastAPI) -> None:
    _install_ws_routes(ws_app)
    with TestClient(ws_app) as tc:
        cookie = _register_and_login(tc)
        headers = {"cookie": f"iclip_session={cookie}"}

        # 白名单跨域放行
        with tc.websocket_connect(
            "/ws-echo", headers={**headers, "origin": "https://allowed.example"}
        ) as ws:
            assert ws.receive_json()["kind"] == "user"

        # 同源（Origin host == Host）放行
        with tc.websocket_connect(
            "/ws-echo", headers={**headers, "origin": "http://testserver"}
        ) as ws:
            assert ws.receive_json()["kind"] == "user"

        # 未知跨域拒绝
        with (
            pytest.raises(WebSocketDisconnect) as exc,
            tc.websocket_connect(
                "/ws-echo", headers={**headers, "origin": "https://evil.example"}
            ) as ws,
        ):
            ws.receive_json()
        assert exc.value.code == 1008
