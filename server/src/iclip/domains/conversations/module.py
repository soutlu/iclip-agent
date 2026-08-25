"""conversations 装配单元：组合根只调用 ``build_conversations_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.conversations.api import create_conversations_router
from iclip.domains.conversations.repository import ConversationRepository
from iclip.domains.conversations.service import ConversationService, PurgeDerived


@dataclass(frozen=True)
class ConversationsModule:
    routers: tuple[Any, ...]
    """路由的类型写 ``Any``（同 identity / generation）：装配单元不该把 web 框架拖进这一环。"""

    service: ConversationService


def build_conversations_module(
    repo: ConversationRepository, *, purge_derived: PurgeDerived
) -> ConversationsModule:
    """装配 conversations。

    ``purge_derived`` 是「删对话时连带删掉派生物」的口子，由组合根接线；本模块不知道
    接上去的是什么，见 ``service.py``。
    """

    service = ConversationService(repo, purge_derived=purge_derived)
    return ConversationsModule(
        routers=(create_conversations_router(service),),
        service=service,
    )


__all__ = ["ConversationsModule", "build_conversations_module"]
