"""已经跑完的那些轮子：从落库的消息与官方事件读回来。

一段对话的持久事实存在两处，这里各取所需：消息历史（``StepPersistence`` 的快照）给出轮、步、
块的全部内容，run 结束事件给出每一轮的终态。两处按 ``run_id`` 对上——顶层 agent 的
``StepPersistence`` 不设 ``agent_name``，于是账本里的 run id 就是消息上的那一个（见
``harness.agents._load_agent``）。

不分页取：一段对话的全部消息本来就存在同一行快照里，读一行和读半行没有区别，页由调用方在
内存里切。

**读快照时把中断的那些也算上**，与起 run 那一侧同一个口径（见 ``runner._history``）。一次运行
抛异常时官方存下来的是一份 ``interrupted`` 快照，它默认不在读取路径上；只读完整的话，失败那一轮
不但自己看不见，还会从此消失——下一次运行拿不到它，于是它也不进后面任何一份快照，轮号被重用。

两侧口径必须一样：显示按一份快照数轮子，起 run 按另一份数，同一段对话就会出现两个同号的轮子。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from pydantic_ai_harness.step_persistence import ContinuableSnapshot, StepEvent

from iclip.harness.transcript.from_messages import (
    TurnState,
    run_error_from_events,
    run_ids_from_messages,
    run_state_from_events,
    turns_from_messages,
)
from iclip.platform.transcript.ops import TranscriptTurn


class ConversationSnapshots(Protocol):
    """按对话取最新存档、按 run 取阶段事件。只要这两口，不要整个 step store。"""

    async def latest_conversation_snapshot(
        self, *, conversation_id: str, include_interrupted: bool = False
    ) -> ContinuableSnapshot | None: ...

    async def list_events(self, *, run_id: str) -> list[StepEvent]: ...


@dataclass(frozen=True, slots=True)
class TranscriptHistory:
    """按对话 id 推出已经跑完的轮子。"""

    store: ConversationSnapshots

    async def turns(self, conversation_id: str) -> tuple[TranscriptTurn, ...]:
        """这段对话到目前为止的轮子，按发生先后排；一份存档都没有就是空的。"""

        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        if snapshot is None:
            return ()
        states: dict[str, TurnState] = {}
        errors: dict[str, str | None] = {}
        for run_id in run_ids_from_messages(snapshot.messages):
            events = await self.store.list_events(run_id=run_id)
            states[run_id] = run_state_from_events(events)
            errors[run_id] = run_error_from_events(events)
        return turns_from_messages(snapshot.messages, turn_states=states, turn_errors=errors)


__all__ = ["ConversationSnapshots", "TranscriptHistory"]
