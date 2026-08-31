"""已经跑完的那些轮子：从落库的消息与官方事件读回来。

一段对话的持久事实存在两处，这里各取所需：消息历史（``StepPersistence`` 的快照）给出轮、步、
块的全部内容，run 结束事件给出每一轮的终态。两处按 ``run_id`` 对上——顶层 agent 的
``StepPersistence`` 不设 ``agent_name``，于是账本里的 run id 就是消息上的那一个（见
``harness.agents._load_agent``）。

不分页取：一段对话的全部消息本来就存在同一行快照里，读一行和读半行没有区别，页由调用方在
内存里切。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from pydantic_ai_harness.step_persistence import ContinuableSnapshot, StepEvent

from iclip.harness.transcript.from_messages import (
    TurnState,
    run_ids_from_messages,
    run_state_from_events,
    turns_from_messages,
)
from iclip.platform.transcript.ops import TranscriptTurn


class ConversationSnapshots(Protocol):
    """按对话取最新存档、按 run 取阶段事件。只要这两口，不要整个 step store。"""

    async def latest_conversation_snapshot(
        self, *, conversation_id: str
    ) -> ContinuableSnapshot | None: ...

    async def list_events(self, *, run_id: str) -> list[StepEvent]: ...


@dataclass(frozen=True, slots=True)
class TranscriptHistory:
    """按对话 id 推出已经跑完的轮子。"""

    store: ConversationSnapshots

    async def turns(self, conversation_id: str) -> tuple[TranscriptTurn, ...]:
        """这段对话到目前为止的轮子，按发生先后排；一份存档都没有就是空的。"""

        snapshot = await self.store.latest_conversation_snapshot(conversation_id=conversation_id)
        if snapshot is None:
            return ()
        states: dict[str, TurnState] = {}
        for run_id in run_ids_from_messages(snapshot.messages):
            states[run_id] = run_state_from_events(await self.store.list_events(run_id=run_id))
        return turns_from_messages(snapshot.messages, turn_states=states)


__all__ = ["ConversationSnapshots", "TranscriptHistory"]
