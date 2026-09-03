"""conversations 装配单元：组合根只调用 ``build_conversations_module``。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from iclip.domains.conversations.api import create_conversations_router
from iclip.domains.conversations.repository import ConversationRepository
from iclip.domains.conversations.service import (
    ActivitiesOf,
    AnnounceTitle,
    ConversationIdsByState,
    ConversationService,
    GenerateTitle,
    ListCollections,
    ListDerivedFiles,
    PurgeDerived,
    ReadDerivedFile,
    WorkspaceDocumentValidator,
    WriteDerivedFile,
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
    write_derived_file: WriteDerivedFile,
    document_validators: Mapping[str, WorkspaceDocumentValidator],
    generate_title: GenerateTitle,
    announce_title: AnnounceTitle,
    activities_of: ActivitiesOf,
    conversation_ids_by_state: ConversationIdsByState,
) -> ConversationsModule:
    """装配 conversations。

    每个口子都由组合根接线：``purge_derived``（删对话时连带删掉派生物）、
    ``list_collections``（侧栏要显示的合集名字）、``list_derived_files`` 与
    ``read_derived_file``、``write_derived_file``（列出、读取、整份写下这段对话里的文件）、
    ``document_validators``（哪条路径上的文件写进去之前要先过谁那一关）、``generate_title``
    （拿模型起个标题）、``announce_title``（标题变了推给还连着的标签页）、``activities_of``
    （这批对话此刻各在忙什么）、``conversation_ids_by_state``（在跑的 / 跑完过的是哪几段）。
    本模块不知道接上去的是什么，见 ``service.py``。
    """

    service = ConversationService(
        repo,
        purge_derived=purge_derived,
        list_collections=list_collections,
        list_derived_files=list_derived_files,
        read_derived_file=read_derived_file,
        write_derived_file=write_derived_file,
        document_validators=document_validators,
        generate_title=generate_title,
        announce_title=announce_title,
        activities_of=activities_of,
        conversation_ids_by_state=conversation_ids_by_state,
    )
    return ConversationsModule(
        routers=(create_conversations_router(service),),
        service=service,
    )


__all__ = ["ConversationsModule", "build_conversations_module"]
