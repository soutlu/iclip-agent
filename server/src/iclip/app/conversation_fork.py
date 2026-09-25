"""对话分叉的适配：分叉用例的两个端口接到 agent 引擎与文件存储上；生成域读副本继承的出片
要的血缘接到对话域上。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime

from iclip.capabilities.workspace.scope import namespace_for
from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.identity.public import Principal
from iclip.harness.jobs import JobQueue
from iclip.harness.transcript.history import TranscriptHistory
from iclip.platform.file_store.store import FileStore
from iclip.platform.material_ledger.pg import PgMaterialLedger


class ForkTranscriptAdapter:
    """副本起点的读写：闲不闲问队列，轮数与种子快照问历史投影。"""

    def __init__(self, *, queue: JobQueue, history: TranscriptHistory) -> None:
        self._queue = queue
        self._history = history

    async def idle(self, conversation_id: uuid.UUID) -> bool:
        view = await self._queue.view(str(conversation_id))
        return view.active is None and not view.queued

    async def turn_count(self, conversation_id: uuid.UUID) -> int:
        return await self._history.turn_count(str(conversation_id))

    async def seed(self, *, source_id: uuid.UUID, target_id: uuid.UUID, turn: int) -> bool:
        plan = await self._history.plan_fork(
            str(source_id), ordinal=turn, target_conversation_id=str(target_id)
        )
        if plan is None:
            # 先数过轮数才动手拷的，走到这儿说明源对话在这期间又跑了一轮。
            return False
        await plan.commit()
        return True


class WorkspaceCopier:
    """工作区文件与素材台账整份搬进副本的命名空间。

    走 FileStore 的写入口而不是裸 SQL：容量上限与路径校验对副本照旧生效。不走会发帧的
    那一层：副本的对话行还没落库，这一刻没人订阅得了它。"""

    def __init__(self, *, store: FileStore, ledger: PgMaterialLedger) -> None:
        self._store = store
        self._ledger = ledger

    async def __call__(
        self,
        *,
        source_owner: uuid.UUID,
        source_id: uuid.UUID,
        target_owner: uuid.UUID,
        target_id: uuid.UUID,
    ) -> None:
        source = namespace_for(source_owner, str(source_id))
        target = namespace_for(target_owner, str(target_id))
        for entry in await self._store.entries(source):
            found = await self._store.read(source, entry.path)
            if found is None:
                # 列得出来却读不出来，只可能是绕过存储写进去的非规范路径：不静默少拷一个文件。
                raise RuntimeError(f"工作区列出了 {entry.path} 却读不出来，这段对话的文件存坏了")
            await self._store.write(target, entry.path, found.content)
        await self._ledger.record(target, await self._ledger.list_all(source))


ConversationReadable = Callable[[Principal, uuid.UUID], Awaitable[bool]]
"""主体读不读得到这段对话；由组合根接到对话服务上。"""


class ForkLineageAdapter:
    """生成域的 ``ConversationLineage``：祖先与边界问对话的 Postgres 仓储，读不读得到问对话服务。

    递归查询只在具体仓储上，不进对话仓储协议。对话服务在生成模块之后才装配，可读判断由组合根
    以闭包在调用时才取。"""

    def __init__(
        self, *, conversations: SqlConversationRepository, readable: ConversationReadable
    ) -> None:
        self._conversations = conversations
        self._readable = readable

    async def ancestry(self, conversation_id: uuid.UUID) -> tuple[tuple[uuid.UUID, datetime], ...]:
        return await self._conversations.ancestry(conversation_id)

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool:
        return await self._readable(principal, conversation_id)


__all__ = ["ForkLineageAdapter", "ForkTranscriptAdapter", "WorkspaceCopier"]
