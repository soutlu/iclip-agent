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
    """使用 Any 隔离 Web 框架类型。"""

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
    """外部依赖由组合根注入，协议定义见 service.py。"""

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
