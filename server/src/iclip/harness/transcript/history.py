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

import uuid
from dataclasses import dataclass
from typing import Protocol

from pydantic_ai_harness.compaction import estimate_context_tokens
from pydantic_ai_harness.step_persistence import ContinuableSnapshot, StepEvent

from iclip.harness.transcript.from_messages import (
    TurnState,
    drop_last_run,
    run_error_from_events,
    run_ids_from_messages,
    run_state_from_events,
    turns_from_messages,
)
from iclip.platform.transcript.ops import TranscriptTurn


class ConversationSnapshots(Protocol):
    """按对话取最新存档、按 run 取阶段事件、写一份存档。只要这三口，不要整个 step store。

    ``save_snapshot`` 是重新生成用的：把截回末轮之前的历史另存成一份新快照，按 ``seq`` 它自动
    成为最新的一份，旧快照留在库里不动。
    """

    async def latest_conversation_snapshot(
        self, *, conversation_id: str, include_interrupted: bool = False
    ) -> ContinuableSnapshot | None: ...

    async def list_events(self, *, run_id: str) -> list[StepEvent]: ...

    async def save_snapshot(self, snapshot: ContinuableSnapshot) -> None: ...


@dataclass(frozen=True, slots=True)
class TranscriptHistoryView:
    turns: tuple[TranscriptTurn, ...]
    context_tokens: int | None


@dataclass(frozen=True, slots=True)
class TranscriptHistory:
    """按对话 id 推出已经跑完的轮子。"""

    store: ConversationSnapshots

    async def read(self, conversation_id: str) -> TranscriptHistoryView:
        """读取可恢复的时间线与 Pydantic AI 上下文读数。"""

        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        if snapshot is None:
            return TranscriptHistoryView(turns=(), context_tokens=None)
        states: dict[str, TurnState] = {}
        errors: dict[str, str | None] = {}
        for run_id in run_ids_from_messages(snapshot.messages):
            events = await self.store.list_events(run_id=run_id)
            states[run_id] = run_state_from_events(events)
            errors[run_id] = run_error_from_events(events)
        return TranscriptHistoryView(
            turns=turns_from_messages(snapshot.messages, turn_states=states, turn_errors=errors),
            context_tokens=estimate_context_tokens(snapshot.messages),
        )

    async def run_ids(self, conversation_id: str) -> tuple[str, ...]:
        """这段对话到目前为止跑过的 run，按发生先后排；一份存档都没有就是空的。

        与分轮同一个口径：中断的那些也算上（见模块开头）。重新生成拿它核对「要动的是不是
        末轮」——轮号 ``t{N}`` 的 N 就是这份列表的长度。
        """

        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        if snapshot is None:
            return ()
        return run_ids_from_messages(snapshot.messages)

    async def rewind_last_turn(self, conversation_id: str, *, run_id: str) -> bool:
        """把落库历史截回 ``run_id`` 那一轮开始之前；它确实是末轮才动手，返回是否截了。

        重新生成靠它把末轮从之后读到的历史里抹掉：历史不删行，截短后的消息另存成一份新
        快照，按写入序它成为最新的一份；旧快照与旧 run 的 runs/events 行原样留在库里。
        快照的 ``run_id`` 另铸一个，不进消息历史，不参与分轮。
        """

        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        kept, dropped = drop_last_run([] if snapshot is None else snapshot.messages)
        if dropped is None or dropped != run_id:
            return False
        await self.store.save_snapshot(
            ContinuableSnapshot(
                run_id=f"regenerate-{uuid.uuid4().hex[:8]}",
                step_index=0,
                messages=kept,
                conversation_id=conversation_id,
            )
        )
        return True


__all__ = ["ConversationSnapshots", "TranscriptHistory"]
