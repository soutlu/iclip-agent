"""对话的持久化端口。

每个方法都收一个 ``owner``：对话只对属主可见。读取那几个允许给 ``None`` 表示不按属主
过滤，那是治理者的审计视图专用——调用方必须先验过权限，这一层只照办。写入没有这个
口子：改名、换归属、删除、记运行一律按属主。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from iclip.domains.conversations.models import Conversation


@dataclass(frozen=True, slots=True)
class CollectionConversations:
    """一个合集里的对话：总条数，加最近的那几段。"""

    collection_id: uuid.UUID
    total: int
    conversations: tuple[Conversation, ...]


@dataclass(frozen=True, slots=True)
class PageCursor:
    """翻页位置：上一页最后一行的排序键。

    用排序键而不是 offset：往后翻会越翻越慢，而且翻页期间有新对话进来会让某些行被跳过。
    侧栏往下滑与治理者的审计列表用的是同一种位置。
    """

    updated_at: datetime
    conversation_id: uuid.UUID


class ConversationRepository(Protocol):
    """``iclip.conversations`` 的数据访问。"""

    async def create(self, conversation: Conversation) -> Conversation:
        """插入一行新对话，返回落库后的整行。"""
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
        self, *, owner: uuid.UUID, limit: int, after: PageCursor | None = None
    ) -> tuple[Conversation, ...]:
        """按最近活动倒序列出这个人没进合集的对话，从 ``after`` 之后接着给。"""
        ...

    async def count_ungrouped(self, *, owner: uuid.UUID) -> int:
        """这个人一共有多少段没进合集的对话。侧栏标题上那个数字要的是总数，不是这一页几条。"""
        ...

    async def list_in_collection(
        self,
        *,
        owner: uuid.UUID,
        collection_id: uuid.UUID,
        limit: int,
        after: PageCursor | None = None,
    ) -> tuple[Conversation, ...]:
        """按最近活动倒序列出某个合集里的对话，从 ``after`` 之后接着给。

        不校验这个合集在不在、是不是他的——这一层不认识合集表。别人的合集查出来是空的，
        和空合集同一个结果，这是有意的（见 contract/conventions.md §6）。
        """
        ...

    async def list_by_collections(
        self, *, owner: uuid.UUID, collection_ids: tuple[uuid.UUID, ...], per_collection: int
    ) -> tuple[CollectionConversations, ...]:
        """一次取回这几个合集各自的条数与最近几段对话。

        一条语句办完：条数与「最近几段」都由窗口函数在库里算，不按合集逐个查。
        """
        ...

    async def list_for_task(
        self, *, task_id: uuid.UUID, owner: uuid.UUID
    ) -> tuple[Conversation, ...]:
        """按开始时间正序列出这个人在某张需求单下的尝试。

        第几次尝试就是这个顺序，所以是正序而不是倒序（别处都按最近活动倒序）。
        """
        ...

    async def list_audit(
        self,
        *,
        owner: uuid.UUID | None = None,
        task_id: uuid.UUID | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: int,
        after: PageCursor | None = None,
    ) -> tuple[Conversation, ...]:
        """跨属主列出对话，按最近活动倒序。四个筛选条件都可以不给，可以任意组合。"""
        ...

    async def rename(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, title: str
    ) -> Conversation:
        """改名，返回改完的整行。"""
        ...

    async def set_collection(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, collection_id: uuid.UUID | None
    ) -> Conversation:
        """换个合集，或者给 ``None`` 把它拿出来。返回改完的整行。

        合集不存在时抛 ``ValidationFailed``——那是外键挡下来的，这一层不认识合集表。
        """
        ...

    async def set_task(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, task_id: uuid.UUID | None
    ) -> Conversation:
        """记在某张需求单下，或者给 ``None`` 摘掉。返回改完的整行。"""
        ...

    async def delete(self, conversation_id: uuid.UUID, *, owner: uuid.UUID) -> None:
        """删掉这一行。已经不在了就抛 ``NotFound``。"""
        ...

    async def touch_run(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, agent_id: str, run_id: str
    ) -> None:
        """记下「这段对话刚开始跑一次运行」：更新 ``last_run_id`` 与 ``updated_at``。

        ``agent_id`` 是一并核对的条件而不是要写入的值：拿 A 的对话去 B 的入口发消息，
        改不到任何一行，于是抛 ``NotFound``。这道核对不能省——工作区的地盘按
        ``{属主}/{对话}`` 划分，里面没有 agent 这一段，不核对的话 B 就跑进了 A 的地盘。
        """
        ...


__all__ = ["CollectionConversations", "ConversationRepository", "PageCursor"]
