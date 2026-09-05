"""对话生命周期、访问控制与派生文件操作。对话 id 由服务端生成。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol

from iclip.common.errors import NotFound, PermissionDenied, ValidationFailed
from iclip.domains.conversations.models import (
    IDLE_ACTIVITY,
    Conversation,
    ConversationActivity,
)
from iclip.domains.conversations.repository import (
    ConversationRepository,
    PageCursor,
)
from iclip.domains.conversations.schemas import DEFAULT_TITLE
from iclip.domains.identity.public import Principal

MAX_LIST_LIMIT = 100
MANAGE_PERMISSION = "users:manage"
"""治理者可读取所有对话及工作区文件；写入仍限属主。"""

SIDEBAR_COLLECTIONS = 100
SIDEBAR_UNGROUPED = 20
SIDEBAR_PER_COLLECTION = 10

ListState = Literal["all", "running", "done"]
"""列表状态筛选；从未运行的对话仅属于 all。"""


ActivitiesOf = Callable[[Sequence[uuid.UUID]], Awaitable[Mapping[uuid.UUID, ConversationActivity]]]
"""批量读取引擎侧活动信息，由组合根注入；未返回的 id 使用 IDLE_ACTIVITY。"""

ConversationIdsByState = Callable[
    [uuid.UUID, Literal["running", "done"]], Awaitable[frozenset[uuid.UUID]]
]
"""按属主与活动状态查询对话 id；从未运行的对话不属于 running 或 done。"""

GenerateTitle = Callable[[str], Awaitable[str | None]]
"""由组合根注入的标题生成器；返回 None 表示本次不生成标题。"""

AnnounceTitle = Callable[[uuid.UUID, uuid.UUID, str], None]
"""同步广播标题更新，参数为 (属主, 对话 id, 标题)。

广播不依赖对话订阅，必须按属主隔离；仅写入出站队列，不等待回执。"""

PurgeDerived = Callable[[uuid.UUID, uuid.UUID], Awaitable[None]]
"""删除对话派生数据，参数为 (属主, 对话 id)；存储与命名空间由注入实现负责。"""


@dataclass(frozen=True, slots=True)
class DerivedFile:
    """对话工作区文件元信息。"""

    path: str
    size_bytes: int
    version: int
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class DerivedFileContent:
    """工作区文件内容与版本。"""

    path: str
    content: str
    version: int


@dataclass(frozen=True, slots=True)
class CollectionInfo:
    """侧栏合集元信息。"""

    id: uuid.UUID
    name: str
    updated_at: datetime


ListCollections = Callable[[uuid.UUID], Awaitable[Sequence[CollectionInfo]]]
"""按最近修改时间倒序读取属主的合集元信息；实现由组合根注入。"""


ListDerivedFiles = Callable[[uuid.UUID, uuid.UUID], Awaitable[Sequence[DerivedFile]]]
"""列出工作区文件，参数为 (属主, 对话 id)。"""

ReadDerivedFile = Callable[[uuid.UUID, uuid.UUID, str], Awaitable[DerivedFileContent | None]]
"""读取工作区文件，参数为 (属主, 对话 id, 路径)；不存在时返回 None。
路径语法由存储实现校验，非法路径抛 ValidationFailed。"""

WriteDerivedFile = Callable[[uuid.UUID, uuid.UUID, str, str, int], Awaitable[DerivedFileContent]]
"""覆盖工作区文件，参数为 (属主, 对话 id, 路径, 正文, 期望版本)。
版本不匹配抛 Conflict；路径和容量由存储实现校验。"""


class WorkspaceDocumentValidator(Protocol):
    """工作区文件写入前的校验协议，由组合根按路径注入。

    校验实现与文件生产方共用规则；失败抛 ValidationFailed，消息返回调用方。"""

    async def __call__(
        self, owner: uuid.UUID, conversation_id: uuid.UUID, content: str
    ) -> None: ...


def _as_utc(moment: datetime | None) -> datetime | None:
    """无时区输入按 UTC 解释，避免与 timestamptz 比较时驱动报错。"""

    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _as_conversation_id(raw: str) -> uuid.UUID:
    """仅接受规范 UUID 字符串，非法输入统一抛 NotFound。

    工作区与实时状态直接使用原字符串作为标识，必须拒绝同一 UUID 的非规范写法，
    避免产生重复命名空间及无法清理的派生数据。"""

    try:
        parsed = uuid.UUID(raw)
    except ValueError as exc:
        raise NotFound("没有这段对话") from exc
    if str(parsed) != raw:
        raise NotFound("没有这段对话")
    return parsed


@dataclass(frozen=True, slots=True)
class ConversationPage:
    """一页对话。``next_cursor`` 为空即没有更多了。"""

    items: tuple[Conversation, ...]
    next_cursor: str | None


def _page(items: tuple[Conversation, ...], *, limit: int) -> ConversationPage:
    """满页时生成下一页游标，避免额外查询；最后一页恰好满额时允许下一页为空。"""

    return ConversationPage(
        items=items, next_cursor=_encode_cursor(items[-1]) if len(items) == limit else None
    )


def _encode_cursor(conversation: Conversation) -> str:

    return f"{conversation.updated_at.isoformat()}|{conversation.id}"


def _decode_cursor(cursor: str | None) -> PageCursor | None:
    """解析游标，格式错误抛 ValidationFailed。"""

    if cursor is None:
        return None
    stamp, _, raw_id = cursor.partition("|")
    try:
        return PageCursor(
            updated_at=datetime.fromisoformat(stamp), conversation_id=uuid.UUID(raw_id)
        )
    except ValueError as exc:
        raise ValidationFailed("cursor 不是一个有效的翻页位置") from exc


class ConversationService:
    """对话生命周期、查询与工作区用例。"""

    def __init__(
        self,
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
    ) -> None:
        self._repo = repo
        self._activities_of = activities_of
        self._ids_by_state = conversation_ids_by_state
        self._purge_derived = purge_derived
        self._generate_title = generate_title
        self._announce_title = announce_title
        self._list_collections = list_collections
        self._list_derived_files = list_derived_files
        self._read_derived_file = read_derived_file
        self._write_derived_file = write_derived_file
        self._document_validators = document_validators

    async def activities(
        self, conversation_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, ConversationActivity]:
        """返回每个请求 id 的活动状态；缺失信息按 IDLE_ACTIVITY 补齐。"""

        known = await self._activities_of(conversation_ids)
        return {one: known.get(one, IDLE_ACTIVITY) for one in conversation_ids}

    def _readable_by(self, principal: Principal) -> uuid.UUID | None:
        """治理者返回 None，取消读取时的属主过滤。"""

        return None if principal.has(MANAGE_PERMISSION) else principal.user_id

    async def files(
        self, principal: Principal, conversation_id: uuid.UUID
    ) -> Sequence[DerivedFile]:
        """列出可见对话的工作区文件；治理者可跨属主读取。"""

        conversation = await self._repo.get(conversation_id, owner=self._readable_by(principal))
        return await self._list_derived_files(conversation.owner_user_id, conversation.id)

    async def file(
        self, principal: Principal, conversation_id: uuid.UUID, *, path: str
    ) -> DerivedFileContent:
        """读取工作区文件；不可见对话或不存在的文件均返回 404。"""

        conversation = await self._repo.get(conversation_id, owner=self._readable_by(principal))
        found = await self._read_derived_file(conversation.owner_user_id, conversation.id, path)
        if found is None:
            raise NotFound("这段对话里没有这个文件")
        return found

    async def write_file(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        *,
        path: str,
        content: str,
        expected_version: int,
    ) -> DerivedFileContent:
        """覆盖属主的工作区文件。不可见对话返回 404，可见但非属主返回 403。"""

        conversation = await self._repo.get(conversation_id, owner=self._readable_by(principal))
        if conversation.owner_user_id != principal.user_id:
            raise PermissionDenied("只有属主能改这段对话的工作区文件")
        validate = self._document_validators.get(path)
        if validate is not None:
            await validate(conversation.owner_user_id, conversation.id, content)
        return await self._write_derived_file(
            conversation.owner_user_id, conversation.id, path, content, expected_version
        )

    async def create(
        self,
        principal: Principal,
        *,
        agent_id: str,
        title: str | None = None,
        task_id: uuid.UUID | None = None,
        collection_id: uuid.UUID | None = None,
    ) -> Conversation:
        """创建服务端 id 的对话；可选归属是否存在由外键约束校验。"""

        now = datetime.now(UTC)
        return await self._repo.create(
            Conversation(
                id=uuid.uuid4(),
                owner_user_id=principal.user_id,
                agent_id=agent_id,
                title=title or DEFAULT_TITLE,
                title_kind="custom" if title else "default",
                last_run_id=None,
                task_id=task_id,
                collection_id=collection_id,
                # 仓储使用数据库 now() 覆盖时间占位值。
                created_at=now,
                updated_at=now,
            )
        )

    async def list_for_task(
        self, principal: Principal, task_id: uuid.UUID
    ) -> tuple[Conversation, ...]:
        """按创建时间正序返回自己的需求单对话；需求单公开不扩大对话可见范围。"""

        return await self._repo.list_for_task(task_id=task_id, owner=principal.user_id)

    async def search(
        self, principal: Principal, *, limit: int = 20, title_query: str | None = None
    ) -> tuple[Conversation, ...]:
        """在数据库中按标题筛选，再按最近活动倒序截取，确保可搜索全部历史。"""

        if not 1 <= limit <= MAX_LIST_LIMIT:
            raise ValidationFailed(f"limit 必须在 1 到 {MAX_LIST_LIMIT} 之间")
        keyword = (title_query or "").strip()
        return await self._repo.list_for_owner(
            owner=principal.user_id, limit=limit, title_contains=keyword or None
        )

    async def _only(self, principal: Principal, state: ListState) -> frozenset[uuid.UUID] | None:
        """返回状态筛选对应的 id 集合；all 返回 None，不限制 id。"""

        if state == "all":
            return None
        return await self._ids_by_state(principal.user_id, state)

    async def sidebar(
        self, principal: Principal, *, state: ListState = "all"
    ) -> tuple[tuple[CollectionInfo, int, ConversationPage], ...]:
        """返回侧栏合集元信息、对话总数及第一页，保留空合集。条数与分页使用相同状态筛选。"""

        collections = await self._list_collections(principal.user_id)
        only_ids = await self._only(principal, state)
        if only_ids is not None and not only_ids:
            return tuple((item, 0, _page((), limit=SIDEBAR_PER_COLLECTION)) for item in collections)
        found = await self._repo.list_by_collections(
            owner=principal.user_id,
            collection_ids=tuple(item.id for item in collections),
            per_collection=SIDEBAR_PER_COLLECTION,
            only_ids=only_ids,
        )
        by_id = {group.collection_id: group for group in found}
        return tuple(
            (
                item,
                by_id[item.id].total if item.id in by_id else 0,
                _page(
                    by_id[item.id].conversations if item.id in by_id else (),
                    limit=SIDEBAR_PER_COLLECTION,
                ),
            )
            for item in collections
        )

    async def ungrouped_count(self, principal: Principal, *, state: ListState = "all") -> int:
        """返回符合状态筛选的未分类对话总数。"""

        only_ids = await self._only(principal, state)
        if only_ids is not None and not only_ids:
            return 0
        return await self._repo.count_ungrouped(owner=principal.user_id, only_ids=only_ids)

    async def ungrouped(
        self, principal: Principal, *, cursor: str | None = None, state: ListState = "all"
    ) -> ConversationPage:
        """按最近活动倒序分页读取自己的未分类对话。"""

        only_ids = await self._only(principal, state)
        if only_ids is not None and not only_ids:
            return _page((), limit=SIDEBAR_UNGROUPED)
        items = await self._repo.list_ungrouped(
            owner=principal.user_id,
            limit=SIDEBAR_UNGROUPED,
            after=_decode_cursor(cursor),
            only_ids=only_ids,
        )
        return _page(items, limit=SIDEBAR_UNGROUPED)

    async def in_collection(
        self,
        principal: Principal,
        collection_id: uuid.UUID,
        *,
        cursor: str | None = None,
        state: ListState = "all",
    ) -> ConversationPage:
        """分页读取合集内的对话；不存在或不可见的合集均返回空页。"""

        only_ids = await self._only(principal, state)
        if only_ids is not None and not only_ids:
            return _page((), limit=SIDEBAR_PER_COLLECTION)
        items = await self._repo.list_in_collection(
            owner=principal.user_id,
            collection_id=collection_id,
            limit=SIDEBAR_PER_COLLECTION,
            after=_decode_cursor(cursor),
            only_ids=only_ids,
        )
        return _page(items, limit=SIDEBAR_PER_COLLECTION)

    async def audit(
        self,
        principal: Principal,
        *,
        owner_user_id: uuid.UUID | None = None,
        task_id: uuid.UUID | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: int = 20,
        cursor: str | None = None,
    ) -> tuple[tuple[Conversation, ...], str | None]:
        """治理者按最近活动倒序分页查询全平台对话。"""

        if not principal.has(MANAGE_PERMISSION):
            raise PermissionDenied("只有治理者能查全部对话")
        if not 1 <= limit <= MAX_LIST_LIMIT:
            raise ValidationFailed(f"limit 必须在 1 到 {MAX_LIST_LIMIT} 之间")
        found = await self._repo.list_audit(
            owner=owner_user_id,
            task_id=task_id,
            since=_as_utc(since),
            until=_as_utc(until),
            limit=limit,
            after=_decode_cursor(cursor),
        )
        page = _page(found, limit=limit)
        return page.items, page.next_cursor

    async def rename(
        self, principal: Principal, conversation_id: uuid.UUID, *, title: str
    ) -> Conversation:
        renamed = await self._repo.rename(conversation_id, owner=principal.user_id, title=title)
        self._announce_title(renamed.owner_user_id, conversation_id, renamed.title)
        return renamed

    async def name_after_turn(self, conversation_id: uuid.UUID, user_text: str) -> None:
        """轮次结束后生成 default 标题；本次未生成时保留 default，后续轮次可再次尝试。"""

        conversation = await self._repo.get(conversation_id, owner=None)
        if conversation.title_kind != "default":
            return
        title = await self._generate_title(user_text)
        if title is None:
            return
        # SQL 条件更新防止生成期间的用户改名被覆盖。
        if await self._repo.apply_generated_title(conversation_id, title=title):
            self._announce_title(conversation.owner_user_id, conversation_id, title)

    async def set_collection(
        self, principal: Principal, conversation_id: uuid.UUID, *, collection_id: uuid.UUID | None
    ) -> Conversation:
        """设置或清空对话的合集归属。"""

        return await self._repo.set_collection(
            conversation_id, owner=principal.user_id, collection_id=collection_id
        )

    async def set_task(
        self, principal: Principal, conversation_id: uuid.UUID, *, task_id: uuid.UUID | None
    ) -> Conversation:
        """设置或清空需求单归属。尝试顺序按对话创建时间计算，重新关联不会改变创建时间。"""

        return await self._repo.set_task(conversation_id, owner=principal.user_id, task_id=task_id)

    async def delete(self, principal: Principal, conversation_id: uuid.UUID) -> None:
        """先清理派生数据，再删除对话记录。

        两者无法共用事务；清理中断时保留对话以便重试，避免产生失去归属的派生数据。"""

        conversation = await self._repo.get(conversation_id, owner=principal.user_id)
        await self._purge_derived(conversation.owner_user_id, conversation.id)
        await self._repo.delete(conversation.id, owner=principal.user_id)

    async def begin_run(
        self, *, owner: uuid.UUID, agent_id: str, conversation_id: str, run_id: str
    ) -> None:
        """核对规范对话 id、属主和 Agent 后记录运行。"""

        await self._repo.touch_run(
            _as_conversation_id(conversation_id), owner=owner, agent_id=agent_id, run_id=run_id
        )

    async def agent_of(self, principal: Principal, conversation_id: str, *, writing: bool) -> str:
        """从可见对话中读取 Agent，拒绝由调用方指定 Agent 绕过对话绑定。

        读取允许治理者跨属主访问；写入始终限定属主。"""

        owner = principal.user_id if writing else self._readable_by(principal)
        conversation = await self._repo.get(_as_conversation_id(conversation_id), owner=owner)
        return conversation.agent_id

    async def title_of(self, principal: Principal, conversation_id: str) -> str:
        """读取可见对话的当前标题；后续更新经 session.meta.updated 推送。"""

        conversation = await self._repo.get(
            _as_conversation_id(conversation_id), owner=self._readable_by(principal)
        )
        return conversation.title


__all__ = [
    "IDLE_ACTIVITY",
    "MANAGE_PERMISSION",
    "MAX_LIST_LIMIT",
    "SIDEBAR_COLLECTIONS",
    "SIDEBAR_PER_COLLECTION",
    "SIDEBAR_UNGROUPED",
    "ActivitiesOf",
    "CollectionInfo",
    "ConversationIdsByState",
    "ConversationService",
    "DerivedFile",
    "DerivedFileContent",
    "ListCollections",
    "ListDerivedFiles",
    "ListState",
    "PurgeDerived",
    "ReadDerivedFile",
    "WorkspaceDocumentValidator",
    "WriteDerivedFile",
]
