"""对话的用例层。

一段对话是用户能看见、能改名、能删掉的东西，所以它必须是服务端记下来的事实：
``id`` 由这里生成，别人拿一个没见过的 id 来发消息一律当作不存在。
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.conversations.models import Conversation
from iclip.domains.conversations.repository import ConversationRepository
from iclip.domains.conversations.schemas import DEFAULT_TITLE
from iclip.domains.identity.public import Principal

MAX_LIST_LIMIT = 100

PurgeDerived = Callable[[uuid.UUID, uuid.UUID], Awaitable[None]]
"""删掉一段对话派生出来的东西，入参是 ``(属主, 对话 id)``。

**这一层不知道那是什么。** 对话的生命周期归它管（删对话要连带删干净），但「附属物长
什么样、存在哪张表、地盘怎么拼名字」是别人的知识。所以这里只留一个口子，接什么由组
合根决定——本模块的代码里因此不会出现工作区的存储与命名空间。
"""


ReadHistory = Callable[[uuid.UUID], Awaitable[tuple[dict[str, Any], ...]]]
"""读一段对话里已经发生过的消息，入参是对话 id。

**这一层不知道消息长什么样。** 对话的归属归它管（能不能看是它的判断），但消息存在
哪、什么形状是别人的知识，所以这里只留一个口子，接什么由组合根决定。
"""


@dataclass(frozen=True, slots=True)
class DerivedFile:
    """agent 在这段对话里写下的一个文件的元信息。"""

    path: str
    size_bytes: int
    version: int
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class DerivedFileContent:
    """一个派生文件的全文与版本号。"""

    path: str
    content: str
    version: int


ListDerivedFiles = Callable[[uuid.UUID, uuid.UUID], Awaitable[Sequence[DerivedFile]]]
"""列出一段对话派生出来的文件，入参是 ``(属主, 对话 id)``。"""

ReadDerivedFile = Callable[[uuid.UUID, uuid.UUID, str], Awaitable[DerivedFileContent | None]]
"""读一段对话派生出来的某个文件，入参是 ``(属主, 对话 id, 路径)``；没有这个文件返回
``None``。路径是用户给的字符串，不合语法时由接线方抛 ``ValidationFailed``——路径的语法
归存储那一侧定，这里不重复一份。
"""


class ConversationService:
    """建对话、列对话、改名、删除，以及读这段对话的历史与派生文件。"""

    def __init__(
        self,
        repo: ConversationRepository,
        *,
        purge_derived: PurgeDerived,
        read_history: ReadHistory,
        list_derived_files: ListDerivedFiles,
        read_derived_file: ReadDerivedFile,
    ) -> None:
        self._repo = repo
        self._purge_derived = purge_derived
        self._read_history = read_history
        self._list_derived_files = list_derived_files
        self._read_derived_file = read_derived_file

    async def history(
        self, principal: Principal, conversation_id: uuid.UUID
    ) -> tuple[dict[str, Any], ...]:
        """读这段对话的历史。先确认它是自己的，别人的一律 404。"""

        await self._repo.get(conversation_id, owner=principal.user_id)
        return await self._read_history(conversation_id)

    async def files(
        self, principal: Principal, conversation_id: uuid.UUID
    ) -> Sequence[DerivedFile]:
        """列出这段对话里写下的文件。先确认它是自己的，别人的一律 404。"""

        conversation = await self._repo.get(conversation_id, owner=principal.user_id)
        return await self._list_derived_files(conversation.owner_user_id, conversation.id)

    async def file(
        self, principal: Principal, conversation_id: uuid.UUID, *, path: str
    ) -> DerivedFileContent:
        """读这段对话里的一个文件。对话不是自己的、或者没有这个文件，都是 404。"""

        conversation = await self._repo.get(conversation_id, owner=principal.user_id)
        found = await self._read_derived_file(conversation.owner_user_id, conversation.id, path)
        if found is None:
            raise NotFound("这段对话里没有这个文件")
        return found

    async def create(
        self,
        principal: Principal,
        *,
        agent_id: str,
        title: str | None = None,
        task_id: uuid.UUID | None = None,
        project_id: uuid.UUID | None = None,
    ) -> Conversation:
        """开一段新对话。id 在这里生成，客户端拿它当会话身份用。

        两个归属都可以不给：那就是「直接开始创作」，既不属于哪张单，也没放进项目。
        给了但不存在，由外键挡下来（这一层不认识那两张表）。
        """

        now = datetime.now(UTC)
        return await self._repo.create(
            Conversation(
                id=uuid.uuid4(),
                owner_user_id=principal.user_id,
                agent_id=agent_id,
                title=title or DEFAULT_TITLE,
                last_run_id=None,
                task_id=task_id,
                project_id=project_id,
                # 两个时刻在插入时由数据库改写成它自己的 now()；这里的值不落库，
                # 只是把 dataclass 填满。
                created_at=now,
                updated_at=now,
            )
        )

    async def list_for_task(
        self, principal: Principal, task_id: uuid.UUID
    ) -> tuple[Conversation, ...]:
        """列出自己在某张需求单下的尝试，按开始时间正序（第几次就是这个顺序）。

        只列自己的：对话是私有的，一张单人人可见不等于这张单下面谁跑过什么也人人可见。
        """

        return await self._repo.list_for_task(task_id=task_id, owner=principal.user_id)

    async def list_recent(
        self, principal: Principal, *, limit: int = 20, title_query: str | None = None
    ) -> tuple[Conversation, ...]:
        """按最近活动倒序列出自己的对话；给了 ``title_query`` 就按标题筛，仍是倒序。

        搜索走库而不是让前端拉回来自己筛：``limit`` 卡的是返回条数，前端拿不到更旧的，
        自己筛就只能筛到最近这几十段。
        """

        if not 1 <= limit <= MAX_LIST_LIMIT:
            raise ValidationFailed(f"limit 必须在 1 到 {MAX_LIST_LIMIT} 之间")
        keyword = (title_query or "").strip()
        return await self._repo.list_for_owner(
            owner=principal.user_id, limit=limit, title_contains=keyword or None
        )

    async def rename(
        self, principal: Principal, conversation_id: uuid.UUID, *, title: str
    ) -> Conversation:
        return await self._repo.rename(conversation_id, owner=principal.user_id, title=title)

    async def set_project(
        self, principal: Principal, conversation_id: uuid.UUID, *, project_id: uuid.UUID | None
    ) -> Conversation:
        """把这段对话放进某个项目，或者给 ``None`` 拿出来。

        不校验「这个项目得是它那张单挂过的」：单挂的项目是新建时的默认值，不是围栏。
        """

        return await self._repo.set_project(
            conversation_id, owner=principal.user_id, project_id=project_id
        )

    async def delete(self, principal: Principal, conversation_id: uuid.UUID) -> None:
        """删掉这段对话，连带删掉它派生出来的东西。

        **先删派生的，再删对话行。** 两者在不同的表、不同的连接上，凑不成一个事务，
        所以顺序就是这里唯一能给的保证：崩在中间留下的是「派生的没了、对话还在」，
        用户再删一次即可；反过来才是真麻烦——对话行没了，那些东西就再也没人认领、
        也没人看得见了。
        """

        conversation = await self._repo.get(conversation_id, owner=principal.user_id)
        await self._purge_derived(conversation.owner_user_id, conversation.id)
        await self._repo.delete(conversation.id, owner=principal.user_id)

    async def begin_run(
        self, *, owner: uuid.UUID, agent_id: str, conversation_id: str, run_id: str
    ) -> None:
        """在这段对话里开始一次运行：核对它归谁、是不是这个 agent 的，并记下这次运行。

        ``conversation_id`` 是客户端在请求体里给的字符串（AG-UI 的 ``threadId``）。不是
        我们发出去的 id 一律当作不存在，不区分「形状不对」和「没有这一行」——区分了就
        等于告诉调用方 id 该长什么样。

        **必须一个字节都不差。** 大写十六进制、去掉短横线、带花括号都能被解析成同一个
        UUID，于是这一关放行了；但下游用的是**原样的字符串**——工作区按它拼命名空间、
        事件流按它拼名字。于是同一段对话会长出第二个工作区、第二条流，而删除时按规范
        写法拼出来的命名空间又碰不到它们。所以解析完再比一次原文。
        """

        try:
            parsed = uuid.UUID(conversation_id)
        except ValueError as exc:
            raise NotFound("没有这段对话") from exc
        if str(parsed) != conversation_id:
            raise NotFound("没有这段对话")
        await self._repo.touch_run(parsed, owner=owner, agent_id=agent_id, run_id=run_id)


__all__ = [
    "MAX_LIST_LIMIT",
    "ConversationService",
    "DerivedFile",
    "DerivedFileContent",
    "ListDerivedFiles",
    "PurgeDerived",
    "ReadDerivedFile",
    "ReadHistory",
]
