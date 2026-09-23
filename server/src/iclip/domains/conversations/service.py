"""对话生命周期、访问控制与派生文件操作。对话 id 由服务端生成。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol

import structlog

from iclip.common.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from iclip.domains.conversations.models import (
    IDLE_ACTIVITY,
    Conversation,
    ConversationActivity,
)
from iclip.domains.conversations.repository import (
    AuditFilter,
    ConversationRepository,
    DeletedFilter,
    PageCursor,
    StateFilter,
)
from iclip.domains.conversations.schemas import DEFAULT_TITLE, MAX_TITLE_CHARS
from iclip.domains.identity.public import ACT_AS_PERMISSION, Principal
from iclip.platform.paging import check_limit, decode_cursor, encode_cursor

_logger = structlog.stdlib.get_logger(__name__)

MANAGE_PERMISSION = "users:manage"
"""治理者可读取所有对话及工作区文件；写入仍限属主。"""

SIDEBAR_COLLECTIONS = 100
"""侧栏最多带几个合集：只取最近建立的这些，更早的连同其中的对话不在侧栏里。"""
SIDEBAR_UNGROUPED = 20
SIDEBAR_PER_COLLECTION = 10

ListState = Literal["all", "running", "done", "open"]
"""列表状态筛选：``done`` / ``open`` 看属主标没标收尾，两者互补；``running`` 是此刻占着的那几段。"""


@dataclass(frozen=True, slots=True)
class AgentEntry:
    """可发起对话的一个顶层 Agent；``name`` 是给人看的名字。"""

    id: str
    name: str


@dataclass(frozen=True, slots=True)
class AgentDirectory:
    """当前装配的顶层 Agent 名册，按声明顺序；``default`` 为空即目录是空的。"""

    items: tuple[AgentEntry, ...]
    default: str | None


ListAgents = Callable[[], AgentDirectory]
"""读当前名册；热重载后再调就是新的一份。"""


ActivitiesOf = Callable[[Sequence[uuid.UUID]], Awaitable[Mapping[uuid.UUID, ConversationActivity]]]
"""批量读取引擎侧活动信息，由组合根注入；未返回的 id 使用 IDLE_ACTIVITY。"""

BusyConversationIds = Callable[[uuid.UUID | None], Awaitable[frozenset[uuid.UUID]]]
"""此刻在跑（含等审批）的对话 id；给属主就按属主算，给 None 算全平台。"""

GenerateTitle = Callable[[str], Awaitable[str | None]]
"""由组合根注入的标题生成器；返回 None 表示本次不生成标题。"""

AnnounceTitle = Callable[[uuid.UUID, uuid.UUID, str], None]
"""同步广播标题更新，参数为 (属主, 对话 id, 标题)。

广播不依赖对话订阅，发给属主与治理者的连接；仅写入出站队列，不等待回执。"""


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


class ListCollections(Protocol):
    """按建立时间倒序读取属主最近建立的至多 ``limit`` 个合集元信息；实现由组合根注入。"""

    async def __call__(self, owner: uuid.UUID, *, limit: int) -> Sequence[CollectionInfo]: ...


ClaimTask = Callable[[uuid.UUID, uuid.UUID], Awaitable[None]]
"""对话挂上需求单就是有人在做了：以 (需求单 id, 对话属主) 认领它。实现由组合根注入。"""


class ForkTranscript(Protocol):
    """副本起点的读写，由组合根接到 agent 引擎上。副本不复制运行记录，只写一张种子快照。"""

    async def idle(self, conversation_id: uuid.UUID) -> bool:
        """这段对话此刻没有在跑、也没有排队的消息。

        与重新生成同一个口径，比对话活动里的 ``busy`` 更严：排队中的那条一旦起跑就会写新快照，
        轮号跟着变，分叉点会指到别的地方去。"""
        ...

    async def turn_count(self, conversation_id: uuid.UUID) -> int:
        """源对话一共几轮；越界的分叉点在拷贝任何东西之前就被挡掉。"""
        ...

    async def seed(self, *, source_id: uuid.UUID, target_id: uuid.UUID, turn: int) -> bool:
        """把源对话截到第 ``turn`` 轮的消息写成副本的第一张快照；源在数过轮数之后又跑了一轮就
        什么都不写、回 ``False``，冲不冲突由用例判。

        消息里的 run_id 照抄源对话：副本靠它们回源查每轮的终态与子代理，不另存一份。"""
        ...


class CopyConversationWorkspace(Protocol):
    """把源对话的工作区文件与素材台账整份拷进副本。

    命名空间是「属主/对话 id」，所以两端的属主都要给。素材必须跟着拷：不拷的话副本续跑时，
    受素材约束的工具会把源对话里那些地址当成没登记过而拒绝。"""

    async def __call__(
        self,
        *,
        source_owner: uuid.UUID,
        source_id: uuid.UUID,
        target_owner: uuid.UUID,
        target_id: uuid.UUID,
    ) -> None: ...


class CopyConversationGenerations(Protocol):
    """把源对话已出片的记录复制到副本名下，返回复制了几条。

    分镜页的结果条按对话 id 查出片记录，不拷它副本打开就是空的。"""

    async def __call__(
        self,
        *,
        source_id: uuid.UUID,
        target_id: uuid.UUID,
        owner: uuid.UUID,
        task_id: uuid.UUID | None,
    ) -> int: ...


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


def _fork_title(source_title: str, turn: int) -> str:
    """副本的默认名字：源标题加一个说明血缘的后缀，超长时截源标题那一半。"""

    suffix = f"（分叉 · 第 {turn} 轮）"
    return source_title[: MAX_TITLE_CHARS - len(suffix)] + suffix


def _as_conversation_id(raw: str) -> uuid.UUID:
    """把字符串形态的对话 id 解析成 UUID，解析不了统一抛 NotFound。

    入口层（REST 路径参数与 WS 帧）已经把两种写法规范化，工作区与实时状态只见到一种拼写；
    这里只负责字符串到 UUID 的交接，不再复校一遍写法。"""

    try:
        return uuid.UUID(raw)
    except ValueError as exc:
        raise NotFound("没有这段对话") from exc


@dataclass(frozen=True, slots=True)
class ConversationPage:
    """一页对话。``next_cursor`` 为空即没有更多了。"""

    items: tuple[Conversation, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class AuditPage:
    """审计的一页，外加两个不随翻页变的真总数：当前筛选下共几段、同一范围内此刻几段在跑。"""

    items: tuple[Conversation, ...]
    next_cursor: str | None
    total: int
    running_total: int


@dataclass(frozen=True, slots=True)
class SidebarGroup:
    """侧栏里的一个合集：元信息、筛选下的对话总数与第一页。"""

    collection: CollectionInfo
    total: int
    page: ConversationPage


@dataclass(frozen=True, slots=True)
class Sidebar:
    """侧栏一屏：合集分组（空合集也在）、未分组的总数与第一页，以及这些页里每段对话的活动状态。"""

    groups: tuple[SidebarGroup, ...]
    ungrouped_total: int
    ungrouped: ConversationPage
    activities: Mapping[uuid.UUID, ConversationActivity]


def _page(items: tuple[Conversation, ...], *, limit: int) -> ConversationPage:
    """满页时生成下一页游标，避免额外查询；最后一页恰好满额时允许下一页为空。"""

    last = items[-1] if len(items) == limit else None
    return ConversationPage(
        items=items,
        next_cursor=None if last is None else encode_cursor(last.created_at, last.id),
    )


def _after(cursor: str | None) -> PageCursor | None:
    """把游标还原成仓库的排序键；``None`` 即从头取。"""

    if cursor is None:
        return None
    parsed = decode_cursor(cursor)
    return PageCursor(created_at=parsed.at, conversation_id=parsed.uuid_key())


class ConversationService:
    """对话生命周期、查询与工作区用例。"""

    def __init__(
        self,
        repo: ConversationRepository,
        *,
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
        copy_generations: CopyConversationGenerations,
    ) -> None:
        self._repo = repo
        self._claim_task = claim_task
        self._fork_transcript = fork_transcript
        self._copy_workspace = copy_workspace
        self._copy_generations = copy_generations
        self._activities_of = activities_of
        self._busy_conversation_ids = busy_conversation_ids
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

    async def _readable(self, principal: Principal, conversation_id: uuid.UUID) -> Conversation:
        """读路径的可见范围：治理者读得到所有人的对话，含属主已删的墓碑；替人办事的钥匙
        读得到所有人活着的对话；其他人只见自己活着的。"""

        if principal.has(MANAGE_PERMISSION):
            return await self._repo.get(conversation_id, owner=None, include_deleted=True)
        if principal.kind == "api_key" and principal.has(ACT_AS_PERMISSION):
            return await self._repo.get(conversation_id, owner=None)
        return await self._repo.get(conversation_id, owner=principal.user_id)

    async def files(
        self, principal: Principal, conversation_id: uuid.UUID
    ) -> Sequence[DerivedFile]:
        """列出可见对话的工作区文件；治理者可跨属主读取。"""

        conversation = await self._readable(principal, conversation_id)
        return await self._list_derived_files(conversation.owner_user_id, conversation.id)

    async def file(
        self, principal: Principal, conversation_id: uuid.UUID, *, path: str
    ) -> DerivedFileContent:
        """读取工作区文件；不可见对话或不存在的文件均返回 404。"""

        conversation = await self._readable(principal, conversation_id)
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

        conversation = await self._readable(principal, conversation_id)
        if conversation.owner_user_id != principal.user_id:
            raise PermissionDenied("只有属主能改这段对话的工作区文件")
        # 治理者读得到自己删掉的对话，但墓碑对谁都是只读的。
        if conversation.deleted_at is not None:
            raise PermissionDenied("已删除的对话不能再改")
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
        conversation_id: uuid.UUID | None = None,
        title: str | None = None,
        task_id: uuid.UUID | None = None,
        collection_id: uuid.UUID | None = None,
    ) -> tuple[Conversation, bool]:
        """创建一段对话，返回它与「本次是否新建」；可选归属是否存在由外键约束校验。

        ``conversation_id`` 由调用方铸时按它幂等：重发同一个 id 返回已有那一段。
        新建时挂了需求单，就以属主认领那张单。"""

        now = datetime.now(UTC)
        conversation, created = await self._repo.create_if_absent(
            Conversation(
                id=conversation_id or uuid.uuid4(),
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
        if created and task_id is not None:
            await self._claim_task(task_id, principal.user_id)
        return conversation, created

    async def fork(
        self,
        principal: Principal,
        source_id: uuid.UUID,
        *,
        turn: int,
        title: str | None = None,
        agent_id: str | None = None,
        collection_id: uuid.UUID | None = None,
    ) -> Conversation:
        """从源对话的第 ``turn`` 轮分叉出一段属于调用者的新对话；源对话只读。

        可见范围与其他读路径一致，所以治理者连墓碑也能分叉。源没闲下来就拒绝：那时最新快照
        可能是半截的，轮号会变。

        副本不挂源的需求单：挂上就是认领，那会动到别人的单子。

        写五处（工作区、素材、出片记录、种子快照、对话行），各自独立提交，对话行最后写。
        中途失败的副本进不了任何对话列表，也读不出
        transcript；拷进去的出片记录按属主仍查得到，是查得到却没人用的孤儿行。
        """

        source = await self._readable(principal, source_id)
        if not await self._fork_transcript.idle(source_id):
            raise Conflict("这段对话还有没跑完的消息，等它收完尾再分叉")
        turns = await self._fork_transcript.turn_count(source_id)
        if turns == 0:
            raise ValidationFailed("这段对话还没跑过，没有可分叉的轮次")
        if turn > turns:
            raise ValidationFailed(f"这段对话只有 {turns} 轮，分不出第 {turn} 轮")
        target_id = uuid.uuid4()
        now = datetime.now(UTC)
        await self._copy_workspace(
            source_owner=source.owner_user_id,
            source_id=source_id,
            target_owner=principal.user_id,
            target_id=target_id,
        )
        await self._copy_generations(
            source_id=source_id, target_id=target_id, owner=principal.user_id, task_id=None
        )
        if not await self._fork_transcript.seed(
            source_id=source_id, target_id=target_id, turn=turn
        ):
            raise Conflict("这段对话刚刚又跑了一轮，重新挑一个分叉点")
        conversation, _ = await self._repo.create_if_absent(
            Conversation(
                id=target_id,
                owner_user_id=principal.user_id,
                agent_id=agent_id or source.agent_id,
                title=title or _fork_title(source.title, turn),
                # 自动起名不碰这个标题：它已经标明了血缘。
                title_kind="custom",
                last_run_id=None,
                task_id=None,
                collection_id=collection_id,
                created_at=now,
                updated_at=now,
                forked_from=source_id,
                fork_turn=turn,
            )
        )
        return conversation

    async def list_for_task(
        self, principal: Principal, task_id: uuid.UUID
    ) -> tuple[Conversation, ...]:
        """按建立时间倒序返回自己的需求单对话；需求单公开不扩大对话可见范围。"""

        return await self._repo.list_for_task(task_id=task_id, owner=principal.user_id)

    async def search(
        self, principal: Principal, *, limit: int = 20, title_query: str | None = None
    ) -> tuple[Conversation, ...]:
        """在数据库中按标题筛选，再按建立时间倒序截取，确保可搜索全部历史。"""

        check_limit(limit)
        keyword = (title_query or "").strip()
        return await self._repo.list_for_owner(
            owner=principal.user_id, limit=limit, title_contains=keyword or None
        )

    async def _state_filter(self, state: ListState, owner: uuid.UUID) -> StateFilter | None:
        """all 不筛；done / open 只看库里的收尾标记，只有 running 才需要算「此刻占着的」那个集合。"""

        if state == "all":
            return None
        busy = await self._busy_conversation_ids(owner) if state == "running" else frozenset()
        return StateFilter(state=state, busy=busy)

    async def sidebar(self, principal: Principal, *, state: ListState = "all") -> Sidebar:
        """一次读出侧栏一屏：最近建立的至多 ``SIDEBAR_COLLECTIONS`` 个合集各带总数与第一页，
        加上未分组的总数与第一页。

        三块共用同一个状态筛选，busy 集只取一次，计数与列表才对得上；所有页里的对话合起来
        只读一次活动状态。"""

        owner = principal.user_id
        chosen = await self._state_filter(state, owner)
        collections = await self._list_collections(owner, limit=SIDEBAR_COLLECTIONS)
        found = await self._repo.list_by_collections(
            owner=owner,
            collection_ids=tuple(item.id for item in collections),
            per_collection=SIDEBAR_PER_COLLECTION,
            state=chosen,
        )
        by_id = {group.collection_id: group for group in found}
        groups = tuple(
            SidebarGroup(
                collection=item,
                total=by_id[item.id].total if item.id in by_id else 0,
                page=_page(
                    by_id[item.id].conversations if item.id in by_id else (),
                    limit=SIDEBAR_PER_COLLECTION,
                ),
            )
            for item in collections
        )
        ungrouped_total = await self._repo.count_ungrouped(owner=owner, state=chosen)
        ungrouped = _page(
            await self._repo.list_ungrouped(owner=owner, limit=SIDEBAR_UNGROUPED, state=chosen),
            limit=SIDEBAR_UNGROUPED,
        )
        pages = (*(group.page for group in groups), ungrouped)
        shown = [item.id for page in pages for item in page.items]
        return Sidebar(
            groups=groups,
            ungrouped_total=ungrouped_total,
            ungrouped=ungrouped,
            activities=await self.activities(shown),
        )

    async def ungrouped(
        self, principal: Principal, *, cursor: str | None = None, state: ListState = "all"
    ) -> ConversationPage:
        """按建立时间倒序分页读取自己的未分类对话。"""

        items = await self._repo.list_ungrouped(
            owner=principal.user_id,
            limit=SIDEBAR_UNGROUPED,
            after=_after(cursor),
            state=await self._state_filter(state, principal.user_id),
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

        items = await self._repo.list_in_collection(
            owner=principal.user_id,
            collection_id=collection_id,
            limit=SIDEBAR_PER_COLLECTION,
            after=_after(cursor),
            state=await self._state_filter(state, principal.user_id),
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
        state: ListState = "all",
        deleted: DeletedFilter = "live",
        limit: int = 20,
        cursor: str | None = None,
    ) -> AuditPage:
        """治理者按建立时间倒序分页查询全平台对话，附当前筛选下的总数与在跑数。

        给了 ``owner_user_id`` 时占着的集合按该属主算，不给才算全平台；busy 集只取一次，
        列表与两个计数才对得上。``deleted`` 决定属主删掉的墓碑收不收，这是唯一列得出墓碑的口。"""

        if not principal.has(MANAGE_PERMISSION):
            raise PermissionDenied("只有治理者能查全部对话")
        check_limit(limit)
        scope = AuditFilter(
            owner=owner_user_id,
            task_id=task_id,
            since=_as_utc(since),
            until=_as_utc(until),
            deleted=deleted,
        )
        busy = await self._busy_conversation_ids(owner_user_id)
        chosen = None if state == "all" else StateFilter(state=state, busy=busy)
        found = await self._repo.list_audit(scope, state=chosen, limit=limit, after=_after(cursor))
        page = _page(found, limit=limit)
        return AuditPage(
            items=page.items,
            next_cursor=page.next_cursor,
            total=await self._repo.count_audit(scope, state=chosen),
            running_total=await self._repo.count_audit(
                scope, state=StateFilter(state="running", busy=busy)
            ),
        )

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
        """设置或清空需求单归属。尝试顺序按对话创建时间计算，重新关联不会改变创建时间。
        挂上的那张单由属主认领；摘掉不动认领记录。"""

        conversation = await self._repo.set_task(
            conversation_id, owner=principal.user_id, task_id=task_id
        )
        if task_id is not None:
            await self._claim_task(task_id, principal.user_id)
        return conversation

    async def set_completed(
        self, principal: Principal, conversation_id: uuid.UUID, *, completed: bool
    ) -> Conversation:
        """标记或取消属主的收尾标记。机器不会自己标；属主再动手会自动取消。"""

        return await self._repo.set_completed(
            conversation_id, owner=principal.user_id, completed=completed
        )

    async def clear_completed(self, conversation_id: uuid.UUID, owner: uuid.UUID) -> None:
        """属主在这段对话里又干活了（如提交出片），收尾标记不再成立。

        供别的域在受理成功后回调：对话不存在、已删或不是这个人的都当没发生，不影响调用方。
        标记本来就是空时照样写一次：提交出片本身就是活动，`updated_at` 该跟着走。"""

        try:
            await self._repo.set_completed(conversation_id, owner=owner, completed=False)
        except NotFound:
            _logger.debug("对话不可见，跳过取消收尾标记", conversation_id=str(conversation_id))

    async def delete(self, principal: Principal, conversation_id: uuid.UUID) -> None:
        """把对话标记删除。工作区与素材台账留着，治理者复盘时还要看。"""

        await self._repo.delete(conversation_id, owner=principal.user_id)

    async def begin_run(
        self, *, owner: uuid.UUID, agent_id: str, conversation_id: str, run_id: str
    ) -> None:
        """解析对话 id、核对属主与 Agent 后记录运行。"""

        await self._repo.touch_run(
            _as_conversation_id(conversation_id), owner=owner, agent_id=agent_id, run_id=run_id
        )

    async def agent_of(self, principal: Principal, conversation_id: str, *, writing: bool) -> str:
        """从可见对话中读取 Agent，拒绝由调用方指定 Agent 绕过对话绑定。

        读取允许治理者跨属主访问，含已删的墓碑；写入始终限定属主活着的对话。"""

        parsed = _as_conversation_id(conversation_id)
        if writing:
            return (await self._repo.get(parsed, owner=principal.user_id)).agent_id
        return (await self._readable(principal, parsed)).agent_id

    async def header_of(self, principal: Principal, conversation_id: str) -> Conversation:
        """读取可见对话的整行，可见范围同 ``agent_of(writing=False)``。会话页首屏用它贴标题、属主与
        删除时刻并取 Agent，一行只读一次；后续改名经 session.meta.updated 推送。"""

        return await self._readable(principal, _as_conversation_id(conversation_id))


__all__ = [
    "IDLE_ACTIVITY",
    "MANAGE_PERMISSION",
    "SIDEBAR_COLLECTIONS",
    "SIDEBAR_PER_COLLECTION",
    "SIDEBAR_UNGROUPED",
    "ActivitiesOf",
    "AgentDirectory",
    "AgentEntry",
    "AuditPage",
    "BusyConversationIds",
    "ClaimTask",
    "CollectionInfo",
    "ConversationService",
    "DeletedFilter",
    "DerivedFile",
    "DerivedFileContent",
    "ListAgents",
    "ListCollections",
    "ListDerivedFiles",
    "ListState",
    "ReadDerivedFile",
    "Sidebar",
    "SidebarGroup",
    "WorkspaceDocumentValidator",
    "WriteDerivedFile",
]
