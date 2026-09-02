"""transcript 对外的那一口：HTTP 与 WS 只跟这里说话。

把「读历史 + 读实时 + 排队 + 驱动」四件事收在一处，是为了让协议里那几条隐性约定只有一个实现
——尤其是「订阅时什么情况下必须先发 reset」和「一页里历史与还没交接的实时轮子怎么接起来」。
散在路由里的话，两个端点各写一遍，迟早不一致。
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime

from iclip.common.errors import Conflict, NotFound, ValidationFailed
from iclip.harness.prompts import PromptQueue
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.store import Listener, TranscriptStore
from iclip.harness.transcript.subscription import subscribe_frames
from iclip.platform.transcript.ops import (
    MAIN_AGENT_ID,
    Prompt,
    PromptContent,
    TranscriptTurn,
    agent_context_status,
)
from iclip.platform.transcript.wire import (
    OpsBatchOut,
    OpsCatchup,
    OpsPayload,
    PromptQueueOut,
    ResetPayload,
    TranscriptPage,
)

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100


@dataclass(frozen=True, slots=True)
class TranscriptService:
    store: TranscriptStore
    history: TranscriptHistory
    queue: PromptQueue
    runner: ConversationRunner
    context_limits: Mapping[str, int]

    # --- 写 -----------------------------------------------------------------

    async def submit(
        self,
        *,
        prompt_id: str,
        conversation_id: str,
        agent_id: str,
        owner_user_id: uuid.UUID,
        content: tuple[PromptContent, ...],
    ) -> Prompt:
        """收下一条消息。空着就地开跑，忙着就排队——哪一种由队列判，不在这里判。"""

        if not content:
            raise ValidationFailed("消息是空的")
        row = await self.queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=agent_id,
            owner_user_id=owner_user_id,
            content=content,
            now=datetime.now(UTC),
        )
        await self.runner.submit(row)
        return row.as_entity()

    async def abort(self, conversation_id: str, prompt_id: str) -> None:
        await self.runner.abort(conversation_id, prompt_id)

    async def regenerate(self, *, conversation_id: str, turn_id: str) -> Prompt:
        """把末轮从历史里抹掉，按那一轮原来那条消息的内容重跑一次。

        寻址用协议里的轮 id（``t{N}``，N 从 1 起）：消息历史按 run 分组，第 N 组就是第 N 轮。
        只允许对**最后一轮**、且这段对话**空闲**时调用：正在跑或排着队是 ``Conflict``，动的
        不是末轮（轮号超出现有轮数也算）也是 ``Conflict``；轮 id 形状不对是
        ``ValidationFailed``。重跑走 ``submit`` 正常开跑，prompt id 由服务端另铸——原来那个
        已被那条记录占用，复用它会被幂等认领直接退回旧记录。
        """

        match = re.fullmatch(r"t([1-9]\d*)", turn_id)
        if match is None:
            raise ValidationFailed(f"不是合法的轮 id：{turn_id}")
        view = await self.queue.view(conversation_id)
        if view.active is not None or view.queued:
            raise Conflict("这段对话还在忙，等它收完尾再重新生成")
        run_ids = await self.history.run_ids(conversation_id)
        if int(match.group(1)) != len(run_ids):
            raise Conflict("只能重新生成最后一轮")
        row = await self.queue.get_by_run(run_ids[-1])
        if row is None:
            raise NotFound(f"找不到这一轮对应的消息：{turn_id}")
        if not await self.history.rewind_last_turn(conversation_id, run_id=run_ids[-1]):
            # 读轮数与动手之间的空隙里这段对话又跑了一轮：要截的已经不是它，拒掉。
            raise Conflict("只能重新生成最后一轮")
        return await self.submit(
            prompt_id=f"prm_regen_{uuid.uuid4().hex[:16]}",
            conversation_id=conversation_id,
            agent_id=row.agent_id,
            owner_user_id=row.owner_user_id,
            content=row.content,
        )

    async def abort_conversation(self, conversation_id: str) -> None:
        await self.runner.abort_conversation(conversation_id)

    async def steer(self, conversation_id: str, prompt_ids: tuple[str, ...]) -> None:
        await self.runner.steer(conversation_id, prompt_ids)

    def approve(self, conversation_id: str, interaction_id: str, *, approved: bool) -> None:
        self.runner.approve(conversation_id, interaction_id, approved=approved)

    # --- 读 -----------------------------------------------------------------

    async def queue_view(self, conversation_id: str) -> PromptQueueOut:
        view = await self.queue.view(conversation_id)
        return PromptQueueOut(
            active=None if view.active is None else view.active.as_entity(),
            queued=tuple(row.as_entity() for row in view.queued),
        )

    async def page(
        self,
        conversation_id: str,
        *,
        agent_id: str = MAIN_AGENT_ID,
        runtime_agent_id: str,
        before_turn: str | None = None,
        after_turn: str | None = None,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> TranscriptPage:
        """一页轮子，默认给最新那几轮。

        历史那份在前、还没交接的实时那份在后：一轮跑完到快照落库之间有一小段时间，它只在实时
        状态里；两份接起来才是完整的一条时间线，光取一边会在那一瞬间少一轮。
        """

        if before_turn is not None and after_turn is not None:
            raise ValidationFailed("before_turn 与 after_turn 只能给一个")
        size = max(1, min(page_size, MAX_PAGE_SIZE))
        view = self.store.subscribe_view(conversation_id, agent_id)
        history = await self.history.read(conversation_id)
        turns = _timeline(history.turns, view.live_turns)
        items, has_more = _slice(turns, before_turn=before_turn, after_turn=after_turn, size=size)
        pending = self.store.pending_interactions(conversation_id, agent_id)
        meta = view.snapshot.meta
        max_context_tokens = self.context_limits.get(runtime_agent_id)
        if (
            meta.agent is None
            and history.context_tokens is not None
            and max_context_tokens is not None
        ):
            meta = meta.model_copy(
                update={"agent": agent_context_status(history.context_tokens, max_context_tokens)}
            )
        return TranscriptPage(
            agent_id=agent_id,
            items=items,
            has_more=has_more,
            interactions=view.snapshot.interactions,
            attachments=view.snapshot.attachments,
            prompts=view.snapshot.prompts,
            meta=meta,
            agents=({"agentId": agent_id, "type": "main"},),
            pending_interactions=tuple(item.interaction_id for item in pending),
            seq=view.watermark,
        )

    def catchup(
        self, conversation_id: str, *, agent_id: str = MAIN_AGENT_ID, since: int
    ) -> OpsCatchup:
        """补上 ``since`` 之后的批次。要不回来时 ``complete`` 为假，客户端整页重拉。"""

        view = self.store.subscribe_view(conversation_id, agent_id, since=since)
        return OpsCatchup(
            agent_id=agent_id,
            batches=tuple(OpsBatchOut(seq=batch.seq, ops=batch.ops) for batch in view.batches),
            latest_seq=view.watermark,
            complete=view.complete,
        )

    # --- 订阅 ---------------------------------------------------------------

    def subscribe(
        self, conversation_id: str, *, agent_id: str = MAIN_AGENT_ID, since: int | None
    ) -> tuple[ResetPayload | OpsPayload, ...]:
        view = self.store.subscribe_view(conversation_id, agent_id, since=since)
        return subscribe_frames(view, agent_id=agent_id, since=since)

    def listen(self, conversation_id: str, listener: Listener, *, agent_id: str) -> None:
        self.store.listen(conversation_id, agent_id, listener)

    def unlisten(self, conversation_id: str, listener: Listener, *, agent_id: str) -> None:
        self.store.unlisten(conversation_id, agent_id, listener)

    def pin(self, conversation_id: str) -> None:
        self.store.pin(conversation_id)

    def unpin(self, conversation_id: str) -> None:
        self.store.unpin(conversation_id)


def _timeline(
    derived: tuple[TranscriptTurn, ...], live: tuple[TranscriptTurn, ...]
) -> tuple[TranscriptTurn, ...]:
    """两份接成一条时间线，按轮号排，同号以实时那份为准（它更新）。"""

    merged = {turn.ordinal: turn for turn in derived}
    merged.update({turn.ordinal: turn for turn in live})
    return tuple(merged[ordinal] for ordinal in sorted(merged))


def _slice(
    turns: tuple[TranscriptTurn, ...], *, before_turn: str | None, after_turn: str | None, size: int
) -> tuple[tuple[TranscriptTurn, ...], bool]:
    """切一页出来，并说清楚前面还有没有。

    ``has_more`` 说的是**更旧的那一头**：界面往上滚才要继续拉，往下是实时推过来的。
    """

    if before_turn is not None:
        end = _index(turns, before_turn)
        start = max(0, end - size)
        return turns[start:end], start > 0
    if after_turn is not None:
        start = _index(turns, after_turn) + 1
        return turns[start : start + size], start > 0
    start = max(0, len(turns) - size)
    return turns[start:], start > 0


def _index(turns: tuple[TranscriptTurn, ...], turn_id: str) -> int:
    for position, turn in enumerate(turns):
        if turn.turn_id == turn_id:
            return position
    raise ValidationFailed(f"这段对话里没有这一轮：{turn_id}")


__all__ = ["DEFAULT_PAGE_SIZE", "MAX_PAGE_SIZE", "TranscriptService"]
