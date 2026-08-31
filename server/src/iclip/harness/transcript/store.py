"""transcript 的实时那一份：进程内的状态、批次号与补批日志。

这里不是持久层。这段对话的持久事实是 ``StepPersistence`` 存的那份消息历史，transcript
是它的投影——已经跑完的轮子由 ``from_messages`` 现推，本模块只负责**正在跑的那一轮**，
外加客户端断线后要补的那几批操作。

于是进程重启后批次号从 1 重新开始，而这是安全的：客户端收到 ``transcript.reset`` 会把
本地水位**无条件覆写**成帧里的 ``seq``（不是取较大值），所以只要订阅时先发一帧 reset，
它就跟着退回来了。这一条是整个设计的支点，别把订阅路径上的 reset 省掉。

**全部方法都是同步的，中途一个 ``await`` 都不能有。** 发号、落地、进日志三件事必须一起
生效：asyncio 只在 ``await`` 处切换任务，所以没有 await 的方法天然是一个临界区，不需要
锁。哪天有人在里面加一个 await，原子性会静默消失——一次 ``subscribe_view`` 会读到一个
发了号但还没落地的中间态，它拼出来的 reset 就比紧跟其后的那批操作还旧。
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Final

from iclip.platform.transcript.ops import (
    AppendOp,
    Attachment,
    AttachmentUpsertOp,
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
"""每个 agent 留多少批可补。要不回来时答 ``complete=False``，客户端整页重拉。"""

RESIDENT_CONVERSATIONS: Final = 256
"""进程内常驻多少段对话。纯内存，给得宽些；被钉住的不参与淘汰。"""


@dataclass(frozen=True, slots=True)
class OpBatch:
    """一批操作加它的批次号。协议要求批次号每 agent 连续递增。"""

    seq: int
    ops: tuple[EmittableOperation, ...]


Listener = Callable[[OpBatch], None]
"""在听的连接。同步的：新批次是在 ``append`` 的临界区里递出去的，不能在那里 await。"""


@dataclass(frozen=True, slots=True)
class SubscribeView:
    """订阅这一刻的一致读。

    四样东西必须来自同一个时刻：``watermark`` 要发在 reset 里，而 ``batches`` 是紧跟其后
    补发的。分成几次 getter 去取的话，中间落一批操作，reset 的水位就会比它后面那些批还新，
    客户端锚在一个不该锚的位置上。
    """

    watermark: int
    snapshot: TranscriptSnapshot
    live_turns: tuple[TranscriptTurn, ...]
    """还没交给消息历史那一侧的轮子。REST 分页要把它接在推导出来的历史后面。"""
    batches: tuple[OpBatch, ...]
    complete: bool
    """``False`` 表示要的批次已经出了日志窗口，客户端得整页重拉。"""


@dataclass(slots=True)
class _LiveStep:
    header: StepHeader
    frames: dict[str, TranscriptFrame] = field(default_factory=dict)


@dataclass(slots=True)
class _LiveTurn:
    header: TurnHeader
    steps: dict[str, _LiveStep] = field(default_factory=dict)
    snapshot_persisted: bool = False
    """消息历史那一侧已经存下这一轮了。置位之后本模块才可以丢掉它。"""


@dataclass(slots=True)
class _AgentTranscript:
    next_seq: int = 1
    journal: deque[OpBatch] = field(default_factory=lambda: deque(maxlen=JOURNAL_CAPACITY))
    turns: dict[str, _LiveTurn] = field(default_factory=dict)
    interactions: dict[str, Interaction] = field(default_factory=dict)
    attachments: dict[str, Attachment] = field(default_factory=dict)
    prompts: dict[str, Prompt] = field(default_factory=dict)
    meta: TranscriptMeta = field(default_factory=TranscriptMeta)


@dataclass(slots=True)
class _Conversation:
    agents: dict[str, _AgentTranscript] = field(default_factory=dict)
    pins: int = 0
    """有运行在跑，或者有连接订阅着。大于零就不淘汰。"""


class TranscriptStore:
    """按对话存实时 transcript。进程内，单进程部署下就是全部。"""

    def __init__(self, *, resident: int = RESIDENT_CONVERSATIONS) -> None:
        self._resident = resident
        # 插入序即最近使用序：命中时挪到末尾，淘汰从头取。
        self._conversations: dict[str, _Conversation] = {}
        self._listeners: dict[tuple[str, str], set[Listener]] = {}

    # --- 写 -----------------------------------------------------------------

    def append(
        self, conversation_id: str, agent_id: str, ops: tuple[EmittableOperation, ...]
    ) -> OpBatch:
        """发一个批次号、把这批操作落到实时状态、进补批日志、递给在听的人。四件事一起生效。"""

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
        """让一个连接跟着收新批次。回调必须是同步的，见模块开头那条不许 await 的规矩。"""

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
        """消息历史那一侧已经存下这一轮，本模块可以放手了。

        交接点是「快照落库了」而不是「轮子进了终态」：终态操作发出去之后快照才在写，这中间
        要是先把轮子丢了，两边都拿不出它，客户端刷新会看到这一轮凭空消失。
        """

        turn = self._agent(conversation_id, agent_id).turns.get(turn_id)
        if turn is not None:
            turn.snapshot_persisted = True

    def drop_persisted_turns(self, conversation_id: str, agent_id: str) -> None:
        """丢掉已经交接完的轮子，实时状态只留还没交接的。"""

        agent = self._agent(conversation_id, agent_id)
        agent.turns = {
            turn_id: turn for turn_id, turn in agent.turns.items() if not turn.snapshot_persisted
        }

    # --- 读 -----------------------------------------------------------------

    def subscribe_view(
        self, conversation_id: str, agent_id: str, *, since: int | None = None
    ) -> SubscribeView:
        """订阅这一刻要的全部东西，一次读出来。

        怎么把这些拼成帧发出去别在调用处自己判，走 ``subscription.subscribe_frames``——
        「什么时候必须先发 reset」是整个设计的支点，判错了不报错，只是界面从此不再更新。
        """

        agent = self._agent(conversation_id, agent_id)
        watermark = agent.next_seq - 1
        batches, complete = self._since(agent, since)
        return SubscribeView(
            watermark=watermark,
            snapshot=TranscriptSnapshot(
                interactions=tuple(agent.interactions.values()),
                attachments=tuple(agent.attachments.values()),
                prompts=tuple(agent.prompts.values()),
                meta=agent.meta,
            ),
            live_turns=tuple(_assemble(turn) for turn in agent.turns.values()),
            batches=batches,
            complete=complete,
        )

    def pending_interactions(self, conversation_id: str, agent_id: str) -> tuple[Interaction, ...]:
        """还没落定的审批与提问。

        停止一个正等审批的轮子、清道夫收拾一个崩掉的轮子，都要把这些取消掉——少这一步，
        界面上会留下永远等不到回应的卡片。
        """

        agent = self._agent(conversation_id, agent_id)
        return tuple(item for item in agent.interactions.values() if item.state == "pending")

    # --- 常驻 ---------------------------------------------------------------

    def pin(self, conversation_id: str) -> None:
        """钉住：有运行在跑，或者有连接订阅着。"""

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
        """淘汰最久没碰过的、没被钉住的那些。"""

        if len(self._conversations) <= self._resident:
            return
        for conversation_id, conversation in list(self._conversations.items()):
            if len(self._conversations) <= self._resident:
                return
            if conversation.pins == 0:
                del self._conversations[conversation_id]

    @staticmethod
    def _since(agent: _AgentTranscript, since: int | None) -> tuple[tuple[OpBatch, ...], bool]:
        """取 ``since`` 之后的批次，并说清楚有没有取全。"""

        if since is None:
            return (), True
        wanted = tuple(batch for batch in agent.journal if batch.seq > since)
        if not wanted:
            # 要的位置已经追上或者超过了水位——超过说明客户端手里的号来自重启前那一代，
            # 让它整页重拉，别默默当成「没有新东西」。
            return (), since <= agent.next_seq - 1
        oldest = agent.journal[0].seq
        return wanted, oldest <= since + 1


def _apply(agent: _AgentTranscript, op: EmittableOperation) -> None:
    """把一个操作落到实时状态上。只认我们自己会发的那些。"""

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
            # 我们是发号方，位置对不上就是投影器算错了。放过去的话客户端会看到缺口、
            # 报错、整页重拉，而服务端这边一切正常——所以在这里就断掉。
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
        case AttachmentUpsertOp():
            agent.attachments[op.attachment.attachment_id] = op.attachment
        case PromptUpsertOp():
            agent.prompts[op.prompt.prompt_id] = op.prompt
        case MetaMergeOp():
            agent.meta = agent.meta.model_copy(
                update=op.meta.model_dump(exclude_none=True, by_alias=False)
            )
        case ItemsRemoveOp():
            _remove_items(agent, op.ids)
        case _:
            # reset 由本模块自己拼给订阅者，不该从投影器流进来。
            raise ValueError(f"实时状态不接受这种操作：{op.op}")


def _remove_items(agent: _AgentTranscript, ids: tuple[str, ...]) -> None:
    """按 id 删掉时间线条目，并把挂在它们工具调用上的交互一并清掉。

    少清那一步，撤销之后界面上会留下永远等不到回应的审批卡（协议里客户端不会自己去清）。
    """

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
    """实时状态 → 线上的嵌套形状。"""

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
