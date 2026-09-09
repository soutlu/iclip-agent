"""子代理流的读取入口：HTTP 带 agent_id、WS 按 agent 订阅、不属于这段对话的 agent 拒绝。

装配走真实 app：主 agent 用会派活的假模型，子代理用分两半说话、中间可以卡住的假模型。
"""

from __future__ import annotations

import asyncio
import threading
import uuid
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, FunctionModel
from starlette.testclient import TestClient

from iclip.config import ResolvedAgent, ResolvedSubAgent
from tests.helpers.runtime import delegates
from tests.helpers.ws import AGENT_ID, drain_turn, open_conversation, sign_in, subscribe, until
from tests.integration_no_llm.conftest import TEST_MODEL_NAME

WRITER = "shot-writer"
WRITER_MODEL = "writer-model"
TASK = "写第 3 组的三个镜头"
FIRST_HALF = "S3-1 特写；"
SECOND_HALF = "S3-2 中景；S3-3 全景"

_ENTERED = threading.Event()
"""子代理说完前半句了。"""
_GATE = threading.Event()
"""放子代理说后半句；app 跑在 TestClient 的线程里，所以用线程事件轮询。"""


def _says_in_two_halves() -> FunctionModel:
    """子代理模型：先说前半句，等门开了再说后半句。默认门是开的，只有重开面板的用例关它。"""

    async def stream(_messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
        yield FIRST_HALF
        _ENTERED.set()
        while not _GATE.is_set():
            await asyncio.sleep(0.02)
        yield SECOND_HALF

    return FunctionModel(stream_function=stream)


@pytest.fixture(autouse=True)
def _open_gate() -> Iterator[None]:
    _ENTERED.clear()
    _GATE.set()
    yield


def _spec(root: Path, name: str) -> Path:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "agent.yaml"
    path.write_text("", encoding="utf-8")
    return path


@pytest.fixture
def agent_declarations(tmp_path: Path) -> tuple[ResolvedAgent, ...]:
    return (
        ResolvedAgent(
            agent_id=AGENT_ID,
            spec=_spec(tmp_path, AGENT_ID),
            instructions=None,
            model=TEST_MODEL_NAME,
            skills=None,
            capabilities=(),
            subagents=(
                ResolvedSubAgent(
                    name=WRITER,
                    spec=_spec(tmp_path, WRITER),
                    instructions=None,
                    model=WRITER_MODEL,
                    skills=None,
                    capabilities=(),
                    timeout_seconds=None,
                    max_calls=None,
                    on_failure=None,
                ),
            ),
        ),
    )


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: delegates((WRITER, TASK)), WRITER_MODEL: _says_in_two_halves()}


def _send(tc: TestClient, conversation_id: str, text_: str) -> None:
    sent = tc.post(
        f"/conversations/{conversation_id}/prompts",
        json={
            "prompt_id": f"prm_{uuid.uuid4().hex[:8]}",
            "content": [{"type": "text", "text": text_}],
        },
    )
    assert sent.status_code == 200, sent.text


def _child_of(ops: list[dict[str, Any]]) -> str:
    """主流工具卡上 agentRefs 指向的子代理 id。"""

    for op in ops:
        if op["op"] == "frame.upsert" and op["frame"].get("agentRefs"):
            return str(op["frame"]["agentRefs"][0]["agentId"])
    raise AssertionError("主流里没有派出子代理的卡")


def _run_a_delegation(tc: TestClient, conversation_id: str) -> str:
    """跑完一轮派活，返回子代理 id。"""

    with tc.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "server_hello"
        subscribe(ws, conversation_id)
        until(ws, "transcript.reset")
        _send(tc, conversation_id, "给这条视频做分镜")
        return _child_of(drain_turn(ws))


def test_a_child_stream_is_read_by_its_agent_id(ws_agent_app: FastAPI, pg_url: str) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        child_id = _run_a_delegation(tc, conversation_id)

        page = tc.get(f"/conversations/{conversation_id}/transcript", params={"agent_id": child_id})
        assert page.status_code == 200, page.text
        body = page.json()
        assert body["agent_id"] == child_id
        assert [(turn["turnId"], turn["state"]) for turn in body["items"]] == [("t1", "completed")]
        assert body["items"][0]["content"] == [{"type": "text", "text": TASK}]
        # 子页的名册和主页同一份：main 加这个子代理。
        assert [agent["agentId"] for agent in body["agents"]] == ["main", child_id]

        catchup = tc.get(
            f"/conversations/{conversation_id}/transcript/ops",
            params={"agent_id": child_id, "since_seq": 0},
        )
        assert catchup.status_code == 200, catchup.text
        assert catchup.json()["agent_id"] == child_id

        # 子 id 只是运行 id，配别的会话读不到；带路径分隔符的 id 连形状都不对。
        other = open_conversation(tc)
        assert (
            tc.get(f"/conversations/{other}/transcript", params={"agent_id": child_id}).status_code
            == 404
        )
        assert (
            tc.get(
                f"/conversations/{conversation_id}/transcript", params={"agent_id": "a/b"}
            ).status_code
            == 422
        )


def test_ws_subscribes_each_agent_in_the_table(ws_agent_app: FastAPI, pg_url: str) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        child_id = _run_a_delegation(tc, conversation_id)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            ws.send_json(
                {
                    "type": "subscribe_v2",
                    "id": "s1",
                    "payload": {
                        "session_id": conversation_id,
                        "transcript": {"main": "delta", child_id: "delta"},
                    },
                }
            )
            resets = {
                until(ws, "transcript.reset")["payload"]["agent_id"],
                until(ws, "transcript.reset")["payload"]["agent_id"],
            }
            assert resets == {"main", child_id}
            assert until(ws, "ack")["payload"]["accepted"] == [conversation_id]

            # 只退子代理，主流照旧收得到。
            ws.send_json(
                {
                    "type": "unsubscribe_v2",
                    "id": "u1",
                    "payload": {"session_id": conversation_id, "agent_ids": [child_id]},
                }
            )
            assert until(ws, "ack")["id"] == "u1"
            _send(tc, conversation_id, "再补一句")
            frames = _drain_frames(ws)
            assert frames and {frame["payload"]["agent_id"] for frame in frames} == {"main"}

            # 表里混进不属于这段对话的 agent：整帧拒绝，已有订阅不动。
            ws.send_json(
                {
                    "type": "subscribe_v2",
                    "id": "s2",
                    "payload": {
                        "session_id": conversation_id,
                        "transcript": {"main": "delta", "not-a-run": "delta"},
                    },
                }
            )
            refused = until(ws, "ack")
            assert (refused["id"], refused["code"]) == ("s2", 404)


def test_reopening_a_running_child_picks_up_where_it_is(ws_agent_app: FastAPI, pg_url: str) -> None:
    """子代理跑到一半才点开它：先拉页看到 running 的 t1 和已说的半句，再带水位订阅接着收。"""

    _GATE.clear()
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id)
            until(ws, "transcript.reset")
            _send(tc, conversation_id, "给这条视频做分镜")
            assert _ENTERED.wait(10), "子代理没开口"
            child_id = _child_from_live_frames(ws)

            page = tc.get(
                f"/conversations/{conversation_id}/transcript", params={"agent_id": child_id}
            ).json()
            assert [(turn["turnId"], turn["state"]) for turn in page["items"]] == [
                ("t1", "running")
            ]
            assert _texts(page["items"][0]) == [FIRST_HALF]

            ws.send_json(
                {
                    "type": "subscribe_v2",
                    "id": "s1",
                    "payload": {
                        "session_id": conversation_id,
                        "transcript": {"main": "delta", child_id: "delta"},
                        "transcript_since": {child_id: page["seq"]},
                    },
                }
            )
            assert until(ws, "ack")["payload"]["accepted"] == [conversation_id]
            _GATE.set()

            child_frames = [
                frame
                for frame in _drain_frames(ws, until_agent=child_id)
                if frame["payload"]["agent_id"] == child_id
            ]
            appended = "".join(
                op["text"]
                for frame in child_frames
                for op in frame["payload"]["ops"]
                if op["op"] == "append"
            )
            assert appended == SECOND_HALF
            assert [
                op["turn"]["state"]
                for frame in child_frames
                for op in frame["payload"]["ops"]
                if op["op"] == "turn.upsert"
            ][-1] == "completed"


def _child_from_live_frames(ws: Any, *, tries: int = 40) -> str:
    """主流里派出子代理的那张卡一到就拿它的 agentRefs。"""

    for _ in range(tries):
        frame = ws.receive_json()
        if frame.get("type") != "transcript.ops":
            continue
        for op in frame["payload"]["ops"]:
            if op["op"] == "frame.upsert" and op["frame"].get("agentRefs"):
                return str(op["frame"]["agentRefs"][0]["agentId"])
    raise AssertionError("主流里没等到派出子代理的卡")


def _texts(turn: dict[str, Any]) -> list[str]:
    return [
        frame["text"]
        for step in turn["steps"]
        for frame in step["frames"]
        if frame["kind"] == "text"
    ]


def _drain_frames(ws: Any, *, until_agent: str = "main", tries: int = 80) -> list[dict[str, Any]]:
    """收 transcript.ops 帧直到某个 agent 的轮到终态；别的 agent 的帧也留着，调用方自己分。"""

    collected: list[dict[str, Any]] = []
    for _ in range(tries):
        frame = ws.receive_json()
        if frame.get("type") != "transcript.ops":
            continue
        collected.append(frame)
        if frame["payload"]["agent_id"] == until_agent and any(
            op["op"] == "turn.upsert" and op["turn"]["state"] != "running"
            for op in frame["payload"]["ops"]
        ):
            return collected
    raise AssertionError("这一轮没等到结束")
