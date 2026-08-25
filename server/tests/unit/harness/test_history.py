"""历史读回来的取材与过滤：system 不外发，崩掉的运行不带走整段历史。"""

from __future__ import annotations

from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    SystemPromptPart,
    UserPromptPart,
)
from pydantic_ai_harness.step_persistence import (
    ContinuableSnapshot,
    InMemoryStepStore,
    RunRecord,
)

from iclip.harness.history import HistoryReader
from iclip.harness.media import MediaCodec

CONVERSATION = "c1"


async def read_after(*runs: tuple[str, list[ModelMessage] | None]) -> tuple[dict[str, Any], ...]:
    """按顺序登记几次运行（``None`` 表示这次没留下完整快照），再读历史。"""

    store = InMemoryStepStore()
    for run_id, messages in runs:
        await store.register_run(RunRecord(run_id=run_id, conversation_id=CONVERSATION))
        if messages is not None:
            await store.save_snapshot(
                ContinuableSnapshot(run_id=run_id, step_index=0, messages=messages)
            )
    return await HistoryReader(step_store=store, media=MediaCodec()).read(CONVERSATION)


async def test_system_messages_from_the_client_are_not_echoed_back() -> None:
    history = await read_after(
        (
            "r1",
            [
                ModelRequest(
                    parts=[
                        SystemPromptPart(content="客户端自己塞的"),
                        UserPromptPart(content="你好"),
                    ]
                )
            ],
        )
    )

    assert [message["role"] for message in history] == ["user"]


async def test_a_run_that_left_no_snapshot_does_not_take_the_history_with_it() -> None:
    """最后那次运行可能崩在半路（进程重启、模型报错），历史不该因此整段消失。"""

    done: list[ModelMessage] = [ModelRequest(parts=[UserPromptPart(content="上一轮说过的话")])]

    history = await read_after(("r1", done), ("r2", None))

    assert [message["content"] for message in history] == ["上一轮说过的话"]
