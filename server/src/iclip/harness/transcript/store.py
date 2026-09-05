"""保存进程内实时投影、批次序号与补发日志；持久事实来自 StepPersistence。

重启后序号重新开始，订阅必须发送 reset，让客户端无条件更新水位。
所有方法保持同步，发号、应用状态与记录日志不可被 await 分割，确保订阅一致读。
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Final

from iclip.platform.transcript.ops import (
    AppendOp,
    EmittableOperation,
    FrameUpsertOp,
    Interaction,
    InteractionUpsertOp,
    ItemsRemoveOp,
    MetaMergeOp,
    Prompt,
    PromptUpsertOp,
    StepHeader,
    StepUpsertOp,
    TextFrame,
    ThinkingFrame,
    ToolFrame,
    TranscriptFrame,
    TranscriptMeta,
    TranscriptSnapshot,
    TranscriptStep,
    TranscriptTurn,
    TurnHeader,
    TurnUpsertOp,
    utf16_len,
)

JOURNAL_CAPACITY: Final = 2000
"""每个 Agent 的补发批次上限，超出窗口时 complete=False。"""

RESIDENT_CONVERSATIONS: Final = 256
"""驻留会话数上限，被固定的会话不参与淘汰。"""


@dataclass(frozen=True, slots=True)
class OpBatch:
    """带连续 Agent 序号的操作批次。"""

    seq: int
    ops: tuple[EmittableOperation, ...]


Listener = Callable[[OpBatch], None]
"""同步订阅回调，在 append 原子操作内通知。"""


@dataclass(frozen=True, slots=True)
class SubscribeView:
    """一次性读取订阅水位、批次与快照，避免多次读取之间产生不一致。"""

    watermark: int
    snapshot: TranscriptSnapshot
    live_turns: tuple[TranscriptTurn, ...]
    """尚未交接到持久化历史的轮次，参与 REST 分页。"""
    batches: tuple[OpBatch, ...]
    complete: bool
    """False 表示所需批次已超出补发窗口，须重新拉取。"""


@dataclass(slots=True)
class _LiveStep:
    header: StepHeader
    frames: dict[str, TranscriptFrame] = field(default_factory=dict)


@dataclass(slots=True)
class _LiveTurn:
    header: TurnHeader
    steps: dict[str, _LiveStep] = field(default_factory=dict)
    snapshot_persisted: bool = False
    """历史已持久化本轮后才允许释放实时状态。"""


@dataclass(slots=True)
class _AgentTranscript:
    next_seq: int = 1
    journal: deque[OpBatch] = field(default_factory=lambda: deque(maxlen=JOURNAL_CAPACITY))
    turns: dict[str, _LiveTurn] = field(default_factory=dict)
    interactions: dict[str, Interaction] = field(default_factory=dict)
    prompts: dict[str, Prompt] = field(default_factory=dict)
    meta: TranscriptMeta = field(default_factory=TranscriptMeta)


@dataclass(slots=True)
class _Conversation:
    agents: dict[str, _AgentTranscript] = field(default_factory=dict)
    pins: int = 0
    """运行与订阅的引用计数，非零时不淘汰。"""


class TranscriptStore:
    """按会话保存的进程内实时投影。"""

    def __init__(self, *, resident: int = RESIDENT_CONVERSATIONS) -> None:
        self._resident = resident
        # 使用插入顺序维护 LRU，命中时移至末尾。
        self._conversations: dict[str, _Conversation] = {}
        self._listeners: dict[tuple[str, str], set[Listener]] = {}

    # --- 写 -----------------------------------------------------------------

    def append(
        self, conversation_id: str, agent_id: str, ops: tuple[EmittableOperation, ...]
    ) -> OpBatch:
        """原子分配序号、应用操作、记录补发日志并通知订阅者。"""

        agent = self._agent(conversation_id, agent_id)
        batch = OpBatch(seq=agent.next_seq, ops=ops)
        agent.next_seq += 1
        for op in ops:
            _apply(agent, op)
        agent.journal.append(batch)
        for listener in tuple(self._listeners.get((conversation_id, agent_id), ())):
            listener(batch)
        return batch

    def listen(self, conversation_id: str, agent_id: str, listener: Listener) -> None:
        """注册同步回调，保持 append 的原子性。"""

        self._listeners.setdefault((conversation_id, agent_id), set()).add(listener)

    def unlisten(self, conversation_id: str, agent_id: str, listener: Listener) -> None:
        key = (conversation_id, agent_id)
        listeners = self._listeners.get(key)
        if listeners is None:
            return
        listeners.discard(listener)
        if not listeners:
            del self._listeners[key]

    def mark_snapshot_persisted(self, conversation_id: str, agent_id: str, turn_id: str) -> None:
        """快照持久化后交接轮次；仅发送终态不足以安全释放实时内容。"""

        turn = self._agent(conversation_id, agent_id).turns.get(turn_id)
        if turn is not None:
            turn.snapshot_persisted = True

    def drop_persisted_turns(self, conversation_id: str, agent_id: str) -> None:
        """释放已交接的实时轮次。"""

        agent = self._agent(conversation_id, agent_id)
        agent.turns = {
            turn_id: turn for turn_id, turn in agent.turns.items() if not turn.snapshot_persisted
        }

    # --- 读 -----------------------------------------------------------------

    def subscribe_view(
        self, conversation_id: str, agent_id: str, *, since: int | None = None
    ) -> SubscribeView:
        """一次读取完整订阅视图；帧构造统一由 subscription.subscribe_frames 决定。"""

        agent = self._agent(conversation_id, agent_id)
        watermark = agent.next_seq - 1
        batches, complete = self._since(agent, since)
        return SubscribeView(
            watermark=watermark,
            snapshot=TranscriptSnapshot(
                interactions=tuple(agent.interactions.values()),
                prompts=tuple(agent.prompts.values()),
                meta=agent.meta,
            ),
            live_turns=tuple(_assemble(turn) for turn in agent.turns.values()),
            batches=batches,
            complete=complete,
        )

    def pending_interactions(self, conversation_id: str, agent_id: str) -> tuple[Interaction, ...]:
        """返回待处理审批和提问，供撤回或失败时统一取消。"""

        agent = self._agent(conversation_id, agent_id)
        return tuple(item for item in agent.interactions.values() if item.state == "pending")

    # --- 常驻 ---------------------------------------------------------------

    def pin(self, conversation_id: str) -> None:
        """运行或订阅期间固定会话，禁止淘汰。"""

        self._conversation(conversation_id).pins += 1

    def unpin(self, conversation_id: str) -> None:
        conversation = self._conversations.get(conversation_id)
        if conversation is not None and conversation.pins > 0:
            conversation.pins -= 1

    # --- 内部 ---------------------------------------------------------------

    def _conversation(self, conversation_id: str) -> _Conversation:
        conversation = self._conversations.pop(conversation_id, None) or _Conversation()
        self._conversations[conversation_id] = conversation
        self._evict()
        return conversation

    def _agent(self, conversation_id: str, agent_id: str) -> _AgentTranscript:
        return self._conversation(conversation_id).agents.setdefault(agent_id, _AgentTranscript())

    def _evict(self) -> None:
        """淘汰未固定且最久未使用的会话。"""

        if len(self._conversations) <= self._resident:
            return
        for conversation_id, conversation in list(self._conversations.items()):
            if len(self._conversations) <= self._resident:
                return
            if conversation.pins == 0:
                del self._conversations[conversation_id]

    @staticmethod
    def _since(agent: _AgentTranscript, since: int | None) -> tuple[tuple[OpBatch, ...], bool]:
        """查询 since 后的批次及完整性。"""

        if since is None:
            return (), True
        wanted = tuple(batch for batch in agent.journal if batch.seq > since)
        if not wanted:
            # 客户端水位高于服务端时可能来自重启前的序列，必须重新拉取。
            return (), since <= agent.next_seq - 1
        oldest = agent.journal[0].seq
        return wanted, oldest <= since + 1


def _apply(agent: _AgentTranscript, op: EmittableOperation) -> None:
    """应用本服务支持的 transcript 操作。"""

    match op:
        case TurnUpsertOp():
            existing = agent.turns.get(op.turn.turn_id)
            if existing is None:
                agent.turns[op.turn.turn_id] = _LiveTurn(header=op.turn)
            else:
                existing.header = op.turn
        case StepUpsertOp():
            turn = agent.turns[op.turn_id]
            existing_step = turn.steps.get(op.step.step_id)
            if existing_step is None:
                turn.steps[op.step.step_id] = _LiveStep(header=op.step)
            else:
                existing_step.header = op.step
        case FrameUpsertOp():
            agent.turns[op.turn_id].steps[op.step_id].frames[op.frame.frame_id] = op.frame
        case AppendOp():
            step = agent.turns[op.target.turn_id].steps[op.target.step_id]
            frame = step.frames[op.target.frame_id]
            if not isinstance(frame, TextFrame | ThinkingFrame):
                raise ValueError(f"只有正文块与思考块能追加，{op.target.frame_id} 是 {frame.kind}")
            # offset 不匹配说明投影器错误，在服务端直接报错，避免客户端反复重拉。
            if utf16_len(frame.text) != op.offset:
                raise ValueError(
                    f"追加位置对不上：块 {op.target.frame_id} 现有 "
                    f"{utf16_len(frame.text)} 个 UTF-16 单位，这一条要从 {op.offset} 接"
                )
            step.frames[op.target.frame_id] = frame.model_copy(
                update={"text": frame.text + op.text}
            )
        case InteractionUpsertOp():
            agent.interactions[op.interaction.interaction_id] = op.interaction
        case PromptUpsertOp():
            agent.prompts[op.prompt.prompt_id] = op.prompt
        case MetaMergeOp():
            update = op.meta.model_dump(exclude_none=True, by_alias=False)
            if op.meta.agent is not None and agent.meta.agent is not None:
                update["agent"] = agent.meta.agent.model_copy(
                    update=op.meta.agent.model_dump(exclude_none=True, by_alias=False)
                )
            elif op.meta.agent is not None:
                update["agent"] = op.meta.agent
            agent.meta = agent.meta.model_copy(update=update)
        case ItemsRemoveOp():
            _remove_items(agent, op.ids)
        case _:
            # reset 仅由订阅路径构造，不接受投影器输出。
            raise ValueError(f"实时状态不接受这种操作：{op.op}")


def _remove_items(agent: _AgentTranscript, ids: tuple[str, ...]) -> None:
    """删除时间线条目及关联工具交互，避免残留审批；客户端协议不会自动清理关联交互。"""

    orphaned = {
        frame.tool_call_id
        for turn_id in ids
        if (turn := agent.turns.get(turn_id)) is not None
        for step in turn.steps.values()
        for frame in step.frames.values()
        if isinstance(frame, ToolFrame)
    }
    for turn_id in ids:
        agent.turns.pop(turn_id, None)
    agent.interactions = {
        key: item
        for key, item in agent.interactions.items()
        if item.tool_call_id is None or item.tool_call_id not in orphaned
    }


def _assemble(turn: _LiveTurn) -> TranscriptTurn:
    """将实时状态转换为协议嵌套结构。"""

    return TranscriptTurn(
        **turn.header.model_dump(by_alias=False),
        steps=tuple(
            TranscriptStep(
                **step.header.model_dump(by_alias=False), frames=tuple(step.frames.values())
            )
            for step in turn.steps.values()
        ),
    )


__all__ = [
    "JOURNAL_CAPACITY",
    "RESIDENT_CONVERSATIONS",
    "Listener",
    "OpBatch",
    "SubscribeView",
    "TranscriptStore",
]
