"""HTTP 与 WebSocket 共用的 transcript 服务，统一历史、实时、队列与订阅重置规则。"""

from __future__ import annotations

import re
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from iclip.common.errors import Conflict, NotFound, ValidationFailed
from iclip.harness.jobs import JobQueue
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.store import Listener, TranscriptStore
from iclip.harness.transcript.subscription import subscribe_frames
from iclip.platform.transcript.ops import (
    MAIN_AGENT_ID,
    ImageContent,
    Interaction,
    ItemsRemoveOp,
    Prompt,
    PromptContent,
    TranscriptTurn,
    VideoContent,
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
    queue: JobQueue
    runner: ConversationRunner
    context_limits: Mapping[str, int]

    record_materials: Callable[[uuid.UUID, str, Sequence[PromptContent]], Awaitable[None]]
    """由组合根注入的附件登记回调，负责素材命名空间。"""

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
        """提交消息，运行或排队状态由持久化队列决定。"""

        if not content:
            raise ValidationFailed("消息是空的")
        for part in content:
            if not isinstance(part, ImageContent | VideoContent):
                continue
            if part.source.url is None or not part.source.url.startswith(("http://", "https://")):
                raise ValidationFailed("附件地址必须是 http(s) 地址")
        # 入队前登记附件，确保排队期间也可被工具引用。
        await self.record_materials(owner_user_id, conversation_id, content)
        row = await self.queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=agent_id,
            owner_user_id=owner_user_id,
            content=content,
            now=datetime.now(UTC),
            locked_by=self.runner.locked_by,
        )
        await self.runner.submit(row)
        return row.as_entity()

    async def abort(self, conversation_id: str, prompt_id: str) -> None:
        await self.runner.abort(conversation_id, prompt_id)

    async def regenerate(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        prompt_id: str | None = None,
        content: tuple[PromptContent, ...] | None = None,
    ) -> Prompt:
        """仅在会话空闲时重新生成末轮，可替换输入内容。

        轮 id 使用 t{N}；格式错误抛 ValidationFailed，忙碌或非末轮抛 Conflict。
        未提供 prompt_id 时生成新 id，避免复用已占用的记录。
        """

        match = re.fullmatch(r"t([1-9]\d*)", turn_id)
        if match is None:
            raise ValidationFailed(f"不是合法的轮 id：{turn_id}")
        if prompt_id is not None:
            claimed = await self.queue.get(prompt_id)
            if claimed is not None:
                # 重复 id 直接返回已有记录，避免截断已重跑的末轮却不启动新运行。
                if claimed.conversation_id != conversation_id:
                    raise Conflict("这个消息 id 已经用过了，换一个")
                return claimed.as_entity()
        view = await self.queue.view(conversation_id)
        if view.active is not None or view.queued:
            raise Conflict("这段对话还在忙，等它收完尾再重新生成")
        rewind = await self.history.plan_rewind(conversation_id, ordinal=int(match.group(1)))
        if rewind is None:
            raise Conflict("只能重新生成最后一轮")
        # 先通过末轮首次 run 查找消息，再提交截断，避免查找失败后已修改历史。
        row = await self.queue.get_by_run(rewind.run_ids[0])
        if row is None:
            raise NotFound(f"找不到这一轮对应的消息：{turn_id}")
        await rewind.commit()
        # 先删除旧轮实体，避免客户端更新头部时保留新回复中已不存在的步骤和块。
        self.store.append(conversation_id, MAIN_AGENT_ID, (ItemsRemoveOp(ids=(turn_id,)),))
        return await self.submit(
            prompt_id=f"prm_regen_{uuid.uuid4().hex[:16]}" if prompt_id is None else prompt_id,
            conversation_id=conversation_id,
            agent_id=row.agent_id,
            owner_user_id=row.owner_user_id,
            content=row.content if content is None else content,
        )

    async def abort_conversation(self, conversation_id: str) -> None:
        await self.runner.abort_conversation(conversation_id)

    async def steer(self, conversation_id: str, prompt_ids: tuple[str, ...]) -> None:
        await self.runner.steer(conversation_id, prompt_ids)

    async def approve(self, conversation_id: str, interaction_id: str, *, approved: bool) -> None:
        await self.runner.approve(conversation_id, interaction_id, approved=approved)

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
        """分页合并历史与尚未交接的实时轮次，覆盖终态发出至快照落库的间隙。"""

        if before_turn is not None and after_turn is not None:
            raise ValidationFailed("before_turn 与 after_turn 只能给一个")
        size = max(1, min(page_size, MAX_PAGE_SIZE))
        view = self.store.subscribe_view(conversation_id, agent_id)
        history = await self.history.read(conversation_id)
        turns = _timeline(history.turns, view.live_turns)
        items, has_more = _slice(turns, before_turn=before_turn, after_turn=after_turn, size=size)
        interactions = _interactions(history.interactions, view.snapshot.interactions)
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
        if (await self.queue.view(conversation_id)).active is not None:
            # 占用状态以持久化队列为准，进程内实时状态无法覆盖重启和其他 worker。
            meta = meta.model_copy(update={"activity": "turn"})
        return TranscriptPage(
            agent_id=agent_id,
            items=items,
            has_more=has_more,
            interactions=interactions,
            prompts=view.snapshot.prompts,
            meta=meta,
            agents=({"agentId": agent_id, "type": "main"},),
            pending_interactions=tuple(
                item.interaction_id for item in interactions if item.state == "pending"
            ),
            seq=view.watermark,
        )

    def catchup(
        self, conversation_id: str, *, agent_id: str = MAIN_AGENT_ID, since: int
    ) -> OpsCatchup:
        """返回 since 后的批次；无法完整补发时 complete=False，客户端重新拉取。"""

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
    """按轮号合并时间线，同号以实时状态为准。"""

    merged = {turn.ordinal: turn for turn in derived}
    merged.update({turn.ordinal: turn for turn in live})
    return tuple(merged[ordinal] for ordinal in sorted(merged))


def _interactions(
    derived: tuple[Interaction, ...], live: tuple[Interaction, ...]
) -> tuple[Interaction, ...]:
    """合并历史与实时审批，同 id 以实时状态为准；重启后的待处理审批从历史恢复。"""

    merged = {item.interaction_id: item for item in derived}
    merged.update({item.interaction_id: item for item in live})
    return tuple(merged.values())


def _slice(
    turns: tuple[TranscriptTurn, ...], *, before_turn: str | None, after_turn: str | None, size: int
) -> tuple[tuple[TranscriptTurn, ...], bool]:
    """分页并返回是否还有更旧轮次；新内容通过实时流提供。"""

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
