"""历史读回来的取材与过滤：取最新那份存档，system 不外发。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic_ai.messages import ModelMessage, ModelRequest, SystemPromptPart, UserPromptPart
from pydantic_ai_harness.step_persistence import ContinuableSnapshot

from iclip.harness.history import HistoryReader
from iclip.harness.media import MediaCodec

CONVERSATION = "c1"


@dataclass
class FakeSnapshots:
    """按对话存一份最新存档的最小状态机。"""

    latest: ContinuableSnapshot | None = None

    async def latest_conversation_snapshot(
        self, *, conversation_id: str
    ) -> ContinuableSnapshot | None:
        return self.latest if conversation_id == CONVERSATION else None


async def read(messages: list[ModelMessage] | None) -> tuple[dict[str, Any], ...]:
    snapshot = (
        None
        if messages is None
        else ContinuableSnapshot(run_id="r1", step_index=0, messages=messages)
    )
    reader = HistoryReader(snapshots=FakeSnapshots(latest=snapshot), media=MediaCodec())
    return await reader.read(CONVERSATION)


async def test_a_conversation_with_no_snapshot_is_empty() -> None:
    """一份存档都没有（还没跑过、或者第一次运行就崩在落档之前）就是空的。"""

    assert await read(None) == ()


async def test_system_messages_from_the_client_are_not_echoed_back() -> None:
    history = await read(
        [
            ModelRequest(
                parts=[
                    SystemPromptPart(content="客户端自己塞的"),
                    UserPromptPart(content="你好"),
                ]
            )
        ]
    )

    assert [message["role"] for message in history] == ["user"]
