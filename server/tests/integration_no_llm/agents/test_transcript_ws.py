"""使用同步 TestClient 验证 WS 握手、订阅和序列化契约。

WS 手工序列化必须保留实体别名，否则客户端 schema 校验会丢弃整帧。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
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


def _subscribe(
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


def _until(ws: Any, kind: str, *, tries: int = 40) -> dict[str, Any]:
    """等待指定帧类型，跳过期间的 ack 和心跳。"""

    for _ in range(tries):
        frame: dict[str, Any] = ws.receive_json()
        if frame.get("type") == kind:
            return frame
    raise AssertionError(f"没收到 {kind}")


def _drain_turn(ws: Any, *, tries: int = 40) -> list[dict[str, Any]]:
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


def test_subscribe_then_receive_ops(ws_agent_app: FastAPI, pg_url: str) -> None:

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)
        conversation_id = _open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "server_hello"
            assert hello["payload"]["heartbeat_ms"] > 0

            _subscribe(ws, conversation_id)
            reset = _until(ws, "transcript.reset")
            # session_id 用于同一连接中的多会话分流。
            assert reset["session_id"] == conversation_id
            assert reset["payload"]["agent_id"] == "main"
            # seq 虽为可选字段，此处必须发送以覆盖客户端水位。
            assert isinstance(reset["payload"]["seq"], int)
            assert reset["payload"]["snapshot"]["items"] == []

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_ws", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text

            ops = _until(ws, "transcript.ops")
            assert ops["payload"]["seq"] >= 1
            assert ops["payload"]["ops"]

            # 嵌套实体需使用 camelCase 别名，保证客户端 schema 校验通过。
            text = json.dumps(ops, ensure_ascii=False)
            assert "turn_id" not in text
            assert "step_id" not in text
            assert "frame_id" not in text

            # 等待运行结束后再断开；运行中断连由独立用例覆盖。
            for _ in range(200):
                queue = tc.get(f"/conversations/{conversation_id}/prompts").json()
                if queue["active"] is None and not queue["queued"]:
                    break
                time.sleep(0.02)


def _settled(tc: TestClient, conversation_id: str, *, tries: int = 200) -> None:
    for _ in range(tries):
        queue = tc.get(f"/conversations/{conversation_id}/prompts").json()
        if queue["active"] is None and not queue["queued"]:
            return
        time.sleep(0.02)
    raise AssertionError("这段对话没跑完")


def test_resubscribing_with_a_stale_watermark_gets_a_reset(
    ws_agent_app: FastAPI, pg_url: str
) -> None:

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)
        conversation_id = _open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            _subscribe(ws, conversation_id, since=99999)
            assert _until(ws, "transcript.reset")["payload"]["seq"] == 0


def test_one_connection_serves_two_conversations(ws_agent_app: FastAPI, pg_url: str) -> None:

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)
        first = _open_conversation(tc)
        second = _open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            _subscribe(ws, first, frame_id="s1")
            _subscribe(ws, second, frame_id="s2")

            landed = {
                _until(ws, "transcript.reset")["session_id"],
                _until(ws, "transcript.reset")["session_id"],
            }
            assert landed == {first, second}


def test_turn_grade_carries_the_turn_but_no_deltas(ws_agent_app: FastAPI, pg_url: str) -> None:

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)
        conversation_id = _open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            _subscribe(ws, conversation_id, grade="turn")
            assert _until(ws, "transcript.reset")["session_id"] == conversation_id

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_turn", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text

            kinds = {op["op"] for op in _drain_turn(ws)}
            assert "turn.upsert" in kinds
            assert kinds.isdisjoint({"append", "frame.upsert", "step.upsert"})


def test_raising_the_grade_replaces_the_whole_thing(ws_agent_app: FastAPI, pg_url: str) -> None:
    """升档必须 reset，低粒度期间被过滤的内容无法仅凭水位完整补发。"""

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)
        conversation_id = _open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            _subscribe(ws, conversation_id, grade="turn")
            assert _until(ws, "transcript.reset")

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_grade", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text
            _drain_turn(ws)

            _subscribe(ws, conversation_id, since=1, frame_id="s2", grade="delta")
            assert _until(ws, "transcript.reset")["session_id"] == conversation_id


def test_subscribing_to_a_conversation_you_cannot_see_is_refused(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """不可见与不存在的会话均拒绝当前订阅，不关闭连接，避免泄漏资源存在性。"""

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            _subscribe(ws, "c-not-mine")

            ack = _until(ws, "ack")
            assert ack["payload"]["not_found"] == ["c-not-mine"]
            assert ack["payload"]["accepted"] == []

            mine = _open_conversation(tc)
            _subscribe(ws, mine, frame_id="s2")
            assert _until(ws, "transcript.reset")["session_id"] == mine


def test_cross_origin_upgrade_is_refused(
    ws_agent_app: FastAPI, pg_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    """WS 升级不受 CORS 约束且携带 cookie，需独立校验 Origin 并记录拒绝原因。"""

    from starlette.websockets import WebSocketDisconnect

    with (
        caplog.at_level(logging.INFO, logger="iclip.domains.agents.transcript_api"),
        TestClient(ws_agent_app) as tc,
    ):
        _sign_in(tc, pg_url)

        with (
            pytest.raises(WebSocketDisconnect) as refused,
            tc.websocket_connect("/ws", headers={"origin": "https://evil.example"}),
        ):
            pass

    assert refused.value.code == 1008
    # structlog 经标准日志转发时，record.msg 保留事件字典。
    assert any(
        record.name == "iclip.domains.agents.transcript_api"
        and isinstance(record.msg, dict)
        and record.msg.get("origin") == "https://evil.example"
        for record in caplog.records
    )


async def _seed_file(pg_url: str, namespace: str, path: str, content: str) -> None:
    """直接插入会话工作区文件。"""

    engine = create_async_engine(pg_url)
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.workspace_files "
                    "(namespace, path, content, version, created_at, updated_at) "
                    "VALUES (:ns, :path, :content, 1, now(), now())"
                ),
                {"ns": namespace, "path": path, "content": content},
            )
    finally:
        await engine.dispose()


def _watch(ws: Any, conversation_id: str, *paths: str) -> dict[str, Any]:
    ws.send_json(
        {
            "type": "watch_fs_add",
            "id": f"watch-{'-'.join(paths)}",
            "payload": {"session_id": conversation_id, "paths": list(paths)},
        }
    )
    return _until(ws, "ack")


def test_fs_changed_reaches_only_the_connections_watching_that_path(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """文件事件仅投递给订阅对应路径的连接；交叉写入验证订阅隔离。"""

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)
        conversation_id = _open_conversation(tc)
        owner = tc.get("/users/me").json()["user"]["id"]
        # PUT 只覆盖已有文件，因此先创建两份基线。
        asyncio.run(_seed_file(pg_url, f"{owner}/{conversation_id}", "提纲.md", "三幕"))
        asyncio.run(_seed_file(pg_url, f"{owner}/{conversation_id}", "其他.md", "甲"))

        with tc.websocket_connect("/ws") as a, tc.websocket_connect("/ws") as b:
            assert a.receive_json()["type"] == "server_hello"
            assert b.receive_json()["type"] == "server_hello"
            ack = _watch(a, conversation_id, "提纲.md")
            assert ack["code"] == 0
            assert ack["payload"] == {"watched_paths": ["提纲.md"], "current_count": 1}
            _watch(b, conversation_id, "其他.md")

            for path, body, version in (("提纲.md", "四幕", 1), ("其他.md", "乙", 1)):
                written = tc.put(
                    f"/conversations/{conversation_id}/workspace/file",
                    json={"path": path, "content": body, "expectedVersion": version},
                )
                assert written.status_code == 200, written.text

            to_a = _until(a, "event.fs.changed")
            to_b = _until(b, "event.fs.changed")

    assert to_a["session_id"] == conversation_id
    assert to_a["payload"] == {
        "changes": [{"path": "提纲.md", "change": "modified", "kind": "file"}],
        "coalesced_window_ms": 0,
    }
    assert to_b["payload"]["changes"] == [{"path": "其他.md", "change": "modified", "kind": "file"}]


def test_watching_an_unknown_conversation_is_refused_without_dropping_the_connection(
    ws_agent_app: FastAPI, pg_url: str
) -> None:

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            ack = _watch(ws, str(uuid.uuid4()), "提纲.md")
            assert ack["code"] == 40401
            conversation_id = _open_conversation(tc)
            assert _watch(ws, conversation_id, "提纲.md")["code"] == 0


def test_activity_frames_reach_a_connection_that_subscribed_nothing(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """会话活动事件供未订阅会话的侧栏使用，不受 subscribe_v2 限制。"""

    with TestClient(ws_agent_app) as tc:
        _sign_in(tc, pg_url)
        conversation_id = _open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_act", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text

            busy = _until(ws, "event.session.work_changed")
            assert busy["session_id"] == conversation_id
            # 未完成过运行时无终态；exclude_none 会省略该字段。
            assert busy["payload"] == {"busy": True, "pending_interaction": "none"}

            idle = _until(ws, "event.session.work_changed")
            assert idle["session_id"] == conversation_id
            assert idle["payload"] == {
                "busy": False,
                "pending_interaction": "none",
                "last_turn_reason": "completed",
            }

            # 列表保留同一活动状态，供事件丢失后重新同步。
            listed = tc.get("/conversations").json()
            row = next(
                item for item in listed["ungrouped"]["items"] if item["id"] == conversation_id
            )
            assert row["activity"] == {
                "busy": False,
                "pendingInteraction": "none",
                "lastTurnReason": "completed",
            }
