"""侧栏用例：三块共用一份状态筛选，活动状态一次读完，合集上限交给组合根。不连库。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import NoReturn, cast

import pytest

from iclip.domains.conversations.models import IDLE_ACTIVITY, Conversation, ConversationActivity
from iclip.domains.conversations.repository import (
    CollectionConversations,
    ConversationRepository,
    PageCursor,
    StateFilter,
)
from iclip.domains.conversations.service import (
    SIDEBAR_COLLECTIONS,
    CollectionInfo,
    ConversationService,
    ForkTranscript,
    ListState,
)
from iclip.domains.identity.public import Principal

NOW = datetime(2026, 9, 22, 12, 0, tzinfo=UTC)
OWNER = Principal(
    kind="user", user_id=uuid.uuid4(), permissions=frozenset({"agent:read"}), audit_label="luke"
)


def conversation(collection_id: uuid.UUID | None, *, age_minutes: int) -> Conversation:
    return Conversation(
        id=uuid.uuid4(),
        owner_user_id=OWNER.user_id,
        agent_id="storyboard",
        title="一段对话",
        title_kind="default",
        last_run_id=None,
        task_id=None,
        collection_id=collection_id,
        created_at=NOW - timedelta(minutes=age_minutes),
        updated_at=NOW,
    )


def collection(name: str) -> CollectionInfo:
    return CollectionInfo(id=uuid.uuid4(), name=name, updated_at=NOW)


@dataclass
class RecordingRepo:
    """只实现侧栏读的三个方法；空合集像真实现一样不出现在分组结果里。记下每次收到的筛选。"""

    grouped: dict[uuid.UUID, tuple[Conversation, ...]]
    loose: tuple[Conversation, ...]
    states: list[StateFilter | None] = field(default_factory=list)

    async def list_by_collections(
        self,
        *,
        owner: uuid.UUID,
        collection_ids: tuple[uuid.UUID, ...],
        per_collection: int,
        state: StateFilter | None = None,
    ) -> tuple[CollectionConversations, ...]:
        self.states.append(state)
        return tuple(
            CollectionConversations(
                collection_id=one,
                total=len(self.grouped[one]),
                conversations=self.grouped[one][:per_collection],
            )
            for one in collection_ids
            if self.grouped.get(one)
        )

    async def count_ungrouped(self, *, owner: uuid.UUID, state: StateFilter | None = None) -> int:
        self.states.append(state)
        return len(self.loose)

    async def list_ungrouped(
        self,
        *,
        owner: uuid.UUID,
        limit: int,
        after: PageCursor | None = None,
        state: StateFilter | None = None,
    ) -> tuple[Conversation, ...]:
        self.states.append(state)
        return self.loose[:limit]


@dataclass
class RecordingCollections:
    items: tuple[CollectionInfo, ...]
    limits: list[int] = field(default_factory=list)

    async def __call__(self, owner: uuid.UUID, *, limit: int) -> Sequence[CollectionInfo]:
        self.limits.append(limit)
        return self.items[:limit]


@dataclass
class ShiftingBusy:
    """每问一次给出不同的一份 busy 集：问了不止一次，三块就会各拿到不同的集合。"""

    answers: list[frozenset[uuid.UUID]]
    owners: list[uuid.UUID | None] = field(default_factory=list)

    async def __call__(self, owner: uuid.UUID | None) -> frozenset[uuid.UUID]:
        self.owners.append(owner)
        return self.answers[len(self.owners) - 1]


@dataclass
class RecordingActivities:
    known: Mapping[uuid.UUID, ConversationActivity]
    calls: list[tuple[uuid.UUID, ...]] = field(default_factory=list)

    async def __call__(
        self, conversation_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, ConversationActivity]:
        self.calls.append(tuple(conversation_ids))
        return {one: self.known[one] for one in conversation_ids if one in self.known}


def _untouched(*_: object, **__: object) -> NoReturn:
    raise AssertionError("侧栏用不到这个端口")


def build(
    repo: RecordingRepo,
    collections: RecordingCollections,
    busy: ShiftingBusy,
    activities: RecordingActivities,
) -> ConversationService:
    return ConversationService(
        cast("ConversationRepository", repo),
        list_collections=collections,
        claim_task=_untouched,
        list_derived_files=_untouched,
        read_derived_file=_untouched,
        write_derived_file=_untouched,
        document_validators={},
        generate_title=_untouched,
        announce_title=_untouched,
        activities_of=activities,
        busy_conversation_ids=busy,
        fork_transcript=cast("ForkTranscript", object()),
        copy_workspace=_untouched,
        copy_generations=_untouched,
    )


async def test_one_busy_set_and_one_activity_read_serve_the_whole_sidebar() -> None:
    spring, empty, autumn = collection("春季"), collection("空的"), collection("秋季")
    spring_items = (
        conversation(spring.id, age_minutes=1),
        conversation(spring.id, age_minutes=2),
    )
    autumn_items = (conversation(autumn.id, age_minutes=3),)
    loose = (conversation(None, age_minutes=4), conversation(None, age_minutes=5))
    running = ConversationActivity(busy=True)
    repo = RecordingRepo(grouped={spring.id: spring_items, autumn.id: autumn_items}, loose=loose)
    collections = RecordingCollections(items=(spring, empty, autumn))
    first_busy = frozenset({spring_items[0].id})
    busy = ShiftingBusy(answers=[first_busy, frozenset(), frozenset()])
    activities = RecordingActivities(known={spring_items[0].id: running})

    view = await build(repo, collections, busy, activities).sidebar(OWNER, state="running")

    assert busy.owners == [OWNER.user_id]
    [shared, *rest] = repo.states
    assert len(rest) == 2 and all(one is shared for one in rest)
    assert shared == StateFilter(state="running", busy=first_busy)
    assert collections.limits == [SIDEBAR_COLLECTIONS]

    shown = (*spring_items, *autumn_items, *loose)
    assert len(activities.calls) == 1
    assert set(activities.calls[0]) == {item.id for item in shown}
    assert view.activities == {
        item.id: running if item is spring_items[0] else IDLE_ACTIVITY for item in shown
    }

    assert [group.collection for group in view.groups] == [spring, empty, autumn]
    assert [(group.total, group.page.items) for group in view.groups] == [
        (2, spring_items),
        (0, ()),
        (1, autumn_items),
    ]
    assert all(group.page.next_cursor is None for group in view.groups)
    assert (view.ungrouped_total, view.ungrouped.items) == (2, loose)


@pytest.mark.parametrize("state", ["all", "done", "open"])
async def test_states_other_than_running_never_ask_for_busy(state: ListState) -> None:
    repo = RecordingRepo(grouped={}, loose=(conversation(None, age_minutes=1),))
    busy = ShiftingBusy(answers=[])
    activities = RecordingActivities(known={})

    await build(repo, RecordingCollections(items=()), busy, activities).sidebar(OWNER, state=state)

    assert busy.owners == []
    [shared, *rest] = repo.states
    assert all(one is shared for one in rest)
    assert shared == (None if state == "all" else StateFilter(state=state, busy=frozenset()))
    assert len(activities.calls) == 1
