"""从快照、运行结束事件与 run→prompt 映射重建历史，三者以 run_id 关联。

读取完整消息快照后由调用方分页。包含中断快照，与运行入口保持相同口径，避免丢失失败轮次或复用轮号。
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart
from pydantic_ai_harness.compaction import estimate_context_tokens
from pydantic_ai_harness.step_persistence import ContinuableSnapshot, StepStore

from iclip.harness.transcript.from_messages import (
    ChildRun,
    TurnState,
    approvals_from_messages,
    drop_last_turn,
    run_error_from_events,
    run_ids_from_messages,
    run_state_from_events,
    tasks_from_messages,
    turn_run_ids,
    turns_from_messages,
)
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.platform.transcript.ops import (
    AgentDescriptor,
    Interaction,
    TranscriptTask,
    TranscriptTurn,
    agents_from_tasks,
)


class ConversationSnapshots(StepStore, Protocol):
    """历史读取与截断所需的存储协议；截断保存为新快照，保留旧记录。

    在官方 StepStore 之上只多一个按对话取快照的入口，其余（运行记录、事件、工具账本）照用协议本身。
    """

    async def latest_conversation_snapshot(
        self, *, conversation_id: str, include_interrupted: bool = False
    ) -> ContinuableSnapshot | None: ...


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
    tasks: tuple[TranscriptTask, ...] = ()
    """本对话派出过的子代理任务。"""
    agents: tuple[AgentDescriptor, ...] = ()


@dataclass(frozen=True, slots=True)
class TranscriptHistory:
    """根据对话 id 重建历史轮次。"""

    store: ConversationSnapshots
    prompt_runs: PromptRunsSource
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY
    """与实时运行共享的工具卡展示规则。"""
    delegate_tool: str | None = None
    """派发工具名；留空则不查子代理账本。"""

    async def read(self, conversation_id: str) -> TranscriptHistoryView:
        """读取可恢复的时间线与 Pydantic AI 上下文读数。"""

        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        if snapshot is None:
            return TranscriptHistoryView(turns=(), context_tokens=None)
        states: dict[str, TurnState] = {}
        errors: dict[str, str | None] = {}
        run_ids = run_ids_from_messages(snapshot.messages)
        for run_id in run_ids:
            events = await self.store.list_events(run_id=run_id)
            states[run_id] = run_state_from_events(events)
            # 取消不是错误：实时侧的 cancelled 轮不带 error，这里也不把 CancelledError 当错误文本。
            errors[run_id] = (
                None if states[run_id] == "cancelled" else run_error_from_events(events)
            )
        of_run = await self.prompt_runs.prompt_of_runs(conversation_id)
        status_of_run = await self.prompt_runs.prompt_status_of_runs(conversation_id)
        subagent_of_call = await self._subagent_of_call(snapshot.messages)
        tasks = tasks_from_messages(
            snapshot.messages,
            subagent_of_call=subagent_of_call,
            child_runs=await self._child_runs(run_ids, states),
        )
        return TranscriptHistoryView(
            turns=turns_from_messages(
                snapshot.messages,
                turn_states=states,
                turn_errors=errors,
                prompt_of_run=of_run,
                prompt_status_of_run=status_of_run,
                subagent_of_call=subagent_of_call,
                display=self.display,
            ),
            context_tokens=estimate_context_tokens(snapshot.messages),
            interactions=approvals_from_messages(
                snapshot.messages,
                turn_states=states,
                prompt_of_run=of_run,
                prompt_status_of_run=status_of_run,
            ),
            tasks=tasks,
            agents=agents_from_tasks(tasks),
        )

    async def _subagent_of_call(self, messages: Sequence[ModelMessage]) -> dict[str, str]:
        """从工具账本读出每次派发调用对上的子运行 id；父工具卡与任务都按它认领。"""

        if self.delegate_tool is None:
            return {}
        found: dict[str, str] = {}
        for message in messages:
            if not isinstance(message, ModelResponse) or message.run_id is None:
                continue
            for part in message.parts:
                if not isinstance(part, ToolCallPart) or part.tool_name != self.delegate_tool:
                    continue
                effect = await self.store.get_tool_effect(
                    run_id=message.run_id, tool_call_id=part.tool_call_id
                )
                if effect is not None and effect.effect_summary is not None:
                    found[part.tool_call_id] = effect.effect_summary
        return found

    async def _child_runs(
        self, run_ids: Sequence[str], parent_states: Mapping[str, TurnState]
    ) -> tuple[ChildRun, ...]:
        """按运行血缘取本对话每个 run 的下属运行；终态与结束时间来自它们自己的事件。

        父运行被停止时子运行收到的是 asyncio 取消，官方不会给它写终态事件；
        这种没有自己终态的子运行随父运行算 cancelled，与实时侧的 killed 对上。
        """

        if self.delegate_tool is None:
            return ()
        children: list[ChildRun] = []
        for run_id in run_ids:
            for record in await self.store.list_runs(parent_run_id=run_id):
                events = await self.store.list_events(run_id=record.run_id)
                ended = any(event.kind in {"run_completed", "run_failed"} for event in events)
                state = run_state_from_events(events)
                if not ended and parent_states.get(run_id) == "cancelled":
                    state = "cancelled"
                children.append(
                    ChildRun(
                        run_id=record.run_id,
                        agent_name=record.metadata.get("agent_name"),
                        started_at=record.started_at,
                        ended_at=events[-1].timestamp if events else None,
                        state=state,
                    )
                )
        return tuple(children)

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
