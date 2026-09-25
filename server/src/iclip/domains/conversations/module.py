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
    BusyConversationIds,
    ClaimTask,
    ConversationService,
    CopyConversationWorkspace,
    ForkTranscript,
    GenerateTitle,
    ListAgents,
    ListCollections,
    ListDerivedFiles,
    ReadDerivedFile,
    WorkspaceDocumentValidator,
    WriteDerivedFile,
)
from iclip.domains.identity.public import ActAs


@dataclass(frozen=True)
class ConversationsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: ConversationService


def build_conversations_module(
    repo: ConversationRepository,
    *,
    act_as: ActAs,
    list_agents: ListAgents,
    list_collections: ListCollections,
    claim_task: ClaimTask,
    list_derived_files: ListDerivedFiles,
    read_derived_file: ReadDerivedFile,
    write_derived_file: WriteDerivedFile,
    document_validators: Mapping[str, WorkspaceDocumentValidator],
    generate_title: GenerateTitle,
    announce_title: AnnounceTitle,
    activities_of: ActivitiesOf,
    busy_conversation_ids: BusyConversationIds,
    fork_transcript: ForkTranscript,
    copy_workspace: CopyConversationWorkspace,
) -> ConversationsModule:
    """外部依赖由组合根注入，协议定义见 service.py。"""

    service = ConversationService(
        repo,
        list_collections=list_collections,
        claim_task=claim_task,
        list_derived_files=list_derived_files,
        read_derived_file=read_derived_file,
        write_derived_file=write_derived_file,
        document_validators=document_validators,
        generate_title=generate_title,
        announce_title=announce_title,
        activities_of=activities_of,
        busy_conversation_ids=busy_conversation_ids,
        fork_transcript=fork_transcript,
        copy_workspace=copy_workspace,
    )
    return ConversationsModule(
        routers=(create_conversations_router(service, agents=list_agents, act_as=act_as),),
        service=service,
    )


__all__ = ["ConversationsModule", "build_conversations_module"]
