"""从快照、运行结束事件与 run→prompt 映射重建历史，三者以 run_id 关联。

读取完整消息快照后由调用方分页。包含中断快照，与运行入口保持相同口径，避免丢失失败轮次或复用轮号。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Protocol

from pydantic_ai.messages import ModelMessage
from pydantic_ai_harness.compaction import estimate_context_tokens
from pydantic_ai_harness.step_persistence import ContinuableSnapshot, StepEvent

from iclip.harness.transcript.from_messages import (
    TurnState,
    approvals_from_messages,
    drop_last_turn,
    run_error_from_events,
    run_ids_from_messages,
    run_state_from_events,
    turn_run_ids,
    turns_from_messages,
)
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.platform.transcript.ops import Interaction, TranscriptTurn


class ConversationSnapshots(Protocol):
    """历史读取与截断所需的快照协议；截断保存为新快照，保留旧记录。"""

    async def latest_conversation_snapshot(
        self, *, conversation_id: str, include_interrupted: bool = False
    ) -> ContinuableSnapshot | None: ...

    async def list_events(self, *, run_id: str) -> list[StepEvent]: ...

    async def save_snapshot(self, snapshot: ContinuableSnapshot) -> None: ...


class PromptRunsSource(Protocol):
    """查询 run 所属消息及其当前状态。"""

    async def prompt_of_runs(self, conversation_id: str) -> dict[str, str]: ...

    async def prompt_status_of_runs(self, conversation_id: str) -> dict[str, str]: ...


@dataclass(frozen=True, slots=True)
class TranscriptHistoryView:
    turns: tuple[TranscriptTurn, ...]
    context_tokens: int | None
    interactions: tuple[Interaction, ...] = ()
    """持久化审批视图，供进程重启后恢复待处理交互。"""


@dataclass(frozen=True, slots=True)
class TranscriptHistory:
    """根据对话 id 重建历史轮次。"""

    store: ConversationSnapshots
    prompt_runs: PromptRunsSource
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY
    """与实时运行共享的工具卡展示规则。"""

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
        of_run = await self.prompt_runs.prompt_of_runs(conversation_id)
        status_of_run = await self.prompt_runs.prompt_status_of_runs(conversation_id)
        return TranscriptHistoryView(
            turns=turns_from_messages(
                snapshot.messages,
                turn_states=states,
                turn_errors=errors,
                prompt_of_run=of_run,
                prompt_status_of_run=status_of_run,
                display=self.display,
            ),
            context_tokens=estimate_context_tokens(snapshot.messages),
            interactions=approvals_from_messages(
                snapshot.messages,
                turn_states=states,
                prompt_of_run=of_run,
                prompt_status_of_run=status_of_run,
            ),
        )

    async def plan_rewind(self, conversation_id: str, *, ordinal: int) -> TurnRewind | None:
        """从同一快照验证并规划末轮截断，不写库；非末轮返回 None。

        调用方可先检查相关 run 数据，再提交截断，避免校验失败后已丢失末轮。
        """

        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        messages = [] if snapshot is None else snapshot.messages
        of_run = await self.prompt_runs.prompt_of_runs(conversation_id)
        if ordinal != len(turn_run_ids(messages, of_run)):
            return None
        kept, dropped = drop_last_turn(messages, of_run)
        return TurnRewind(
            store=self.store, conversation_id=conversation_id, kept=kept, run_ids=dropped
        )


@dataclass(frozen=True, slots=True)
class TurnRewind:
    """尚未落库的截断计划，run_ids 为末轮包含的运行。"""

    store: ConversationSnapshots
    conversation_id: str
    kept: list[ModelMessage]
    run_ids: tuple[str, ...]

    async def commit(self) -> None:
        """将截断结果保存为新快照，保留旧快照和事件；新快照 run_id 不参与消息分轮。"""

        await self.store.save_snapshot(
            ContinuableSnapshot(
                run_id=f"regenerate-{uuid.uuid4().hex[:8]}",
                step_index=0,
                messages=self.kept,
                conversation_id=self.conversation_id,
            )
        )


__all__ = ["ConversationSnapshots", "PromptRunsSource", "TranscriptHistory", "TurnRewind"]
