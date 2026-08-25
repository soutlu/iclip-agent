"""对话的持久化端口。

只按属主读写，没有「治理者看全部」的口子：对话不是审计对象，而且「能看别人的对话」
很容易滑成「能在别人的对话里跑 agent」——那会把工作区也一并交出去。
"""

from __future__ import annotations

import uuid
from typing import Protocol

from iclip.domains.conversations.models import Conversation


class ConversationRepository(Protocol):
    """``iclip.conversations`` 的数据访问。"""

    async def create(self, conversation: Conversation) -> Conversation:
        """插入一行新对话，返回落库后的整行。"""
        ...

    async def get(self, conversation_id: uuid.UUID, *, owner: uuid.UUID) -> Conversation:
        """按 id 读一行；不是这个人的一律抛 ``NotFound``（不泄露它存不存在）。"""
        ...

    async def list_for_owner(self, *, owner: uuid.UUID, limit: int) -> tuple[Conversation, ...]:
        """按最近活动倒序列出这个人的对话。"""
        ...

    async def list_for_task(
        self, *, task_id: uuid.UUID, owner: uuid.UUID
    ) -> tuple[Conversation, ...]:
        """按开始时间正序列出这个人在某张需求单下的尝试。

        第几次尝试就是这个顺序，所以是正序而不是倒序（别处都按最近活动倒序）。
        """
        ...

    async def rename(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, title: str
    ) -> Conversation:
        """改名，返回改完的整行。"""
        ...

    async def set_project(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, project_id: uuid.UUID | None
    ) -> Conversation:
        """换个项目，或者给 ``None`` 把它拿出来。返回改完的整行。

        项目不存在时抛 ``ValidationFailed``——那是外键挡下来的，这一层不认识项目表。
        """
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


__all__ = ["ConversationRepository"]
