"""conversations 装配单元：组合根只调用 ``build_conversations_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.conversations.api import create_conversations_router
from iclip.domains.conversations.repository import ConversationRepository
from iclip.domains.conversations.service import (
    ConversationService,
    ListCollections,
    ListDerivedFiles,
    PurgeDerived,
    ReadDerivedFile,
)


@dataclass(frozen=True)
class ConversationsModule:
    routers: tuple[Any, ...]
    """路由的类型写 ``Any``（同 identity / generation）：装配单元不该把 web 框架拖进这一环。"""

    service: ConversationService


def build_conversations_module(
    repo: ConversationRepository,
    *,
    purge_derived: PurgeDerived,
    list_collections: ListCollections,
    list_derived_files: ListDerivedFiles,
    read_derived_file: ReadDerivedFile,
) -> ConversationsModule:
    """装配 conversations。

    四个口子都由组合根接线：``purge_derived``（删对话时连带删掉派生物）
    （读这段对话发生过的消息）、``list_collections``（侧栏要显示的合集名字）、
    ``list_derived_files`` 与 ``read_derived_file``（列出、读取 agent 在这段对话里写下的
    文件）。本模块不知道接上去的是什么，见 ``service.py``。
    """

    service = ConversationService(
        repo,
        purge_derived=purge_derived,
        list_collections=list_collections,
        list_derived_files=list_derived_files,
        read_derived_file=read_derived_file,
    )
    return ConversationsModule(
        routers=(create_conversations_router(service),),
        service=service,
    )


__all__ = ["ConversationsModule", "build_conversations_module"]
