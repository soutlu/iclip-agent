"""对话持久化端口。读操作的 owner=None 用于已授权的治理视图；写操作始终限定属主。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol

from iclip.domains.conversations.models import Conversation


@dataclass(frozen=True, slots=True)
class CollectionConversations:
    """合集的对话总数与最近对话。"""

    collection_id: uuid.UUID
    total: int
    conversations: tuple[Conversation, ...]


@dataclass(frozen=True, slots=True)
class PageCursor:
    """使用上一页末行的排序键分页，避免 offset 的深分页开销与插入造成的位置漂移。"""

    updated_at: datetime
    conversation_id: uuid.UUID


@dataclass(frozen=True, slots=True)
class StateFilter:
    """列表的 ``state`` 筛选。``running`` 是 ``busy`` 里那几段；``done`` 是 ``last_run_id`` 非空且不在 ``busy`` 里。

    ``busy`` 是此刻占着的对话，由调用方按属主或全平台算好传进来。``all`` 不需要它：传 ``None`` 即不筛。"""

    state: Literal["running", "done"]
    busy: frozenset[uuid.UUID]


@dataclass(frozen=True, slots=True)
class AuditFilter:
    """审计的筛选范围，列表与计数共用；四项都可以不给。``since`` / ``until`` 作用在 ``updated_at`` 上。"""

    owner: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    since: datetime | None = None
    until: datetime | None = None


class ConversationRepository(Protocol):
    """``iclip.conversations`` 的数据访问。"""

    async def create_if_absent(self, conversation: Conversation) -> tuple[Conversation, bool]:
        """按 id 幂等插入一行新对话。

        返回落库后的整行与「本次是否新建」；id 已存在时不写入，返回已有那一行。
        已存在那一行属于别人，或这个 id 对应的对话已删除时抛 ``NotFound``。
        已使用的 id 永不重新分配，避免新对话接上保留的运行历史。"""
        ...

    async def get(self, conversation_id: uuid.UUID, *, owner: uuid.UUID | None) -> Conversation:
        """按 id 读一行；不是这个人的一律抛 ``NotFound``（不泄露它存不存在）。"""
        ...

    async def list_for_owner(
        self, *, owner: uuid.UUID, limit: int, title_contains: str | None = None
    ) -> tuple[Conversation, ...]:
        """按最近活动倒序列出这个人的对话；给了 ``title_contains`` 就只留标题含它的（不分大小写）。"""
        ...

    async def list_ungrouped(
        self,
        *,
        owner: uuid.UUID,
        limit: int,
        after: PageCursor | None = None,
        state: StateFilter | None = None,
    ) -> tuple[Conversation, ...]:
        """按最近活动倒序列出这个人没进合集的对话，从 ``after`` 之后接着给。

        ``state`` 是列表的状态筛选，``None`` 即不限定。
        """
        ...

    async def count_ungrouped(self, *, owner: uuid.UUID, state: StateFilter | None = None) -> int:
        """返回符合条件的未分类对话总数，不受分页限制。"""
        ...

    async def list_in_collection(
        self,
        *,
        owner: uuid.UUID,
        collection_id: uuid.UUID,
        limit: int,
        after: PageCursor | None = None,
        state: StateFilter | None = None,
    ) -> tuple[Conversation, ...]:
        """按最近活动倒序分页。不存在或不可见的合集均返回空结果，见 contract/conventions.md §6。"""
        ...

    async def list_by_collections(
        self,
        *,
        owner: uuid.UUID,
        collection_ids: tuple[uuid.UUID, ...],
        per_collection: int,
        state: StateFilter | None = None,
    ) -> tuple[CollectionConversations, ...]:
        """批量返回各合集的对话总数与最近对话，由同一条 SQL 计算。"""
        ...

    async def list_for_task(
        self, *, task_id: uuid.UUID, owner: uuid.UUID
    ) -> tuple[Conversation, ...]:
        """按创建时间正序返回属主在需求单下的对话，此顺序定义尝试次序。"""
        ...

    async def list_audit(
        self,
        scope: AuditFilter,
        *,
        state: StateFilter | None = None,
        limit: int,
        after: PageCursor | None = None,
    ) -> tuple[Conversation, ...]:
        """跨属主列出对话，按最近活动倒序。``scope`` 与 ``state`` 可以任意组合。"""
        ...

    async def count_audit(self, scope: AuditFilter, *, state: StateFilter | None = None) -> int:
        """同一组筛选下的总条数，不受翻页影响；条件拼装与 ``list_audit`` 共用。"""
        ...

    async def apply_generated_title(self, conversation_id: uuid.UUID, *, title: str) -> bool:
        """原子更新 default 标题并返回是否成功，避免并发生成或用户改名被覆盖。"""
        ...

    async def rename(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, title: str
    ) -> Conversation:
        """改名并标记为 custom，后续自动生成不得覆盖。"""
        ...

    async def set_collection(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, collection_id: uuid.UUID | None
    ) -> Conversation:
        """设置或清空合集归属；不存在的合集由外键约束拒绝并转换为 ValidationFailed。"""
        ...

    async def set_task(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, task_id: uuid.UUID | None
    ) -> Conversation:
        """设置或清空需求单归属，返回更新后的记录。"""
        ...

    async def delete(self, conversation_id: uuid.UUID, *, owner: uuid.UUID) -> None:
        """标记删除：行留着占住 id，之后任何读写都当它不存在。已删或本来就没有都抛 ``NotFound``。"""
        ...

    async def touch_run(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, agent_id: str, run_id: str
    ) -> None:
        """更新 last_run_id 与 updated_at，同时核对属主和 agent_id。

        工作区仅按属主与对话隔离，必须校验 agent_id，防止其他 Agent 使用该工作区。"""
        ...


__all__ = ["CollectionConversations", "ConversationRepository", "PageCursor"]
