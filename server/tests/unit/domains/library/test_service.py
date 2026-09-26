"""资料库用例层：按读者算能否打开来源对话、详情带镜头组、游标往返、总数只在第一页、参数校验。不连库。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.identity.models import PrincipalKind
from iclip.domains.identity.public import ACT_AS_PERMISSION, MANAGE_PERMISSION, Principal
from iclip.domains.library.models import Scope, VideoCursor
from iclip.domains.library.repository import CardRow
from iclip.domains.library.schemas import (
    FaceOut,
    LibraryAuthorOut,
    LibraryVideoOut,
    ShotGroupOut,
    TakeOut,
    VersionOut,
)
from iclip.domains.library.service import LibraryService

NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)
OWNER = uuid.uuid4()


def principal(user_id: uuid.UUID, *permissions: str, kind: PrincipalKind = "user") -> Principal:
    return Principal(
        kind=kind,
        user_id=user_id,
        permissions=frozenset({"generation:read", *permissions}),
        audit_label="someone",
    )


def take(take_id: uuid.UUID) -> TakeOut:
    return TakeOut(
        id=take_id,
        model="mmt-seedance-2-5",
        aspect_ratio="9:16",
        seconds=10,
        resolution="720p",
        generate_audio=False,
        prompt="模特走向镜头。",
        script=None,
        reference_image_urls=[],
    )


def card(
    at: datetime, *, conversation_owner: uuid.UUID | None = OWNER, deleted: bool = False
) -> CardRow:
    """一张卡；``conversation_owner`` 为空就是不挂对话的卡，卡 id 用出片 id。"""

    take_id = uuid.uuid4()
    conversation_id = uuid.uuid4() if conversation_owner else None
    return CardRow(
        video=LibraryVideoOut(
            id=conversation_id or take_id,
            conversation_id=conversation_id,
            can_open_conversation=False,
            title="春夏凉鞋合集" if conversation_id else None,
            agent_id="storyboard" if conversation_id else None,
            task_id=None,
            user_name="Nina.He",
            group_count=1,
            version_count=1,
            face=FaceOut(
                kind="take",
                job_id=take_id,
                output_url=f"https://oss.example.test/{take_id}.mp4",
                watermark_output_url=None,
                duration_ms=None,
                finished_at=at,
                user_name="Nina.He",
            ),
            take=take(take_id),
        ),
        conversation_owner=conversation_owner,
        conversation_deleted=deleted,
    )


@dataclass
class FakeReports:
    cards: list[CardRow] = field(default_factory=list)
    counted: list[Scope] = field(default_factory=list)
    queried: list[tuple[Scope, VideoCursor | None]] = field(default_factory=list)

    async def videos(
        self, scope: Scope, *, limit: int, after: VideoCursor | None
    ) -> Sequence[CardRow]:
        self.queried.append((scope, after))
        rows = sorted(self.cards, key=lambda row: (row.video.face.finished_at, row.video.id))
        rows.reverse()
        if after is not None:
            key = (after.at, after.video_id)
            rows = [row for row in rows if (row.video.face.finished_at, row.video.id) < key]
        return rows[:limit]

    async def count(self, scope: Scope) -> int:
        self.counted.append(scope)
        return len(self.cards)

    async def card_of(self, card_id: uuid.UUID) -> CardRow | None:
        return next((row for row in self.cards if row.video.id == card_id), None)

    async def groups_of(self, card_id: uuid.UUID) -> Sequence[ShotGroupOut]:
        row = await self.card_of(card_id)
        if row is None:
            return []
        face = row.video.face
        return [
            ShotGroupOut(
                shot_index=1, versions=[VersionOut(**face.model_dump(), take=row.video.take)]
            )
        ]

    async def authors(self) -> Sequence[LibraryAuthorOut]:
        return [LibraryAuthorOut(user_name="Nina.He", count=len(self.cards))]


async def test_can_open_follows_the_conversation_read_scope() -> None:
    """活着的、删了的、不挂对话的三张卡，逐个读者看能不能打开来源对话。"""

    alive = card(NOW)
    dead = card(NOW - timedelta(hours=1), deleted=True)
    orphan = card(NOW - timedelta(hours=2), conversation_owner=None)
    service = LibraryService(FakeReports([alive, dead, orphan]))

    async def can_open(reader: Principal) -> list[bool]:
        return [item.can_open_conversation for item in (await service.videos(reader)).items]

    assert await can_open(principal(OWNER)) == [True, False, False]
    assert await can_open(principal(uuid.uuid4())) == [False, False, False]
    assert await can_open(principal(uuid.uuid4(), MANAGE_PERMISSION)) == [True, True, False]
    act_as_key = principal(uuid.uuid4(), ACT_AS_PERMISSION, kind="api_key")
    assert await can_open(act_as_key) == [True, False, False]
    assert await can_open(principal(uuid.uuid4(), ACT_AS_PERMISSION)) == [False, False, False], (
        "替人办事只看钥匙，用户账号带这个权限也不放开"
    )


async def test_everyone_gets_the_conversation_and_the_script() -> None:
    row = card(NOW)
    service = LibraryService(FakeReports([row]))

    as_colleague = (await service.videos(principal(uuid.uuid4()))).items[0]

    assert as_colleague.conversation_id == row.video.conversation_id
    assert as_colleague.id == row.video.conversation_id
    assert as_colleague.title == "春夏凉鞋合集"
    assert as_colleague.take == row.video.take


async def test_detail_carries_the_groups_and_the_reader_view() -> None:
    first, second = card(NOW), card(NOW - timedelta(hours=1))
    reports = FakeReports([first, second])
    service = LibraryService(reports)

    as_owner = await service.video(principal(OWNER), first.video.id)
    as_colleague = await service.video(principal(uuid.uuid4()), first.video.id)

    assert as_owner.groups == list(await reports.groups_of(first.video.id))
    assert [v.job_id for g in as_owner.groups for v in g.versions] == [first.video.face.job_id]
    assert as_owner.video.can_open_conversation is True
    assert as_colleague.video.can_open_conversation is False
    assert as_colleague.groups == as_owner.groups


async def test_an_id_that_is_not_a_card_is_not_found() -> None:
    row = card(NOW)
    service = LibraryService(FakeReports([row]))

    for outside in (row.video.face.job_id, uuid.uuid4()):
        with pytest.raises(NotFound):
            await service.video(principal(OWNER), outside)


async def test_cursor_keys_on_the_face_finish_time_and_total_is_only_on_page_one() -> None:
    reports = FakeReports([card(NOW - timedelta(minutes=minute)) for minute in range(5)])
    service = LibraryService(reports)

    first = await service.videos(principal(OWNER), limit=2)
    second = await service.videos(principal(OWNER), limit=2, cursor=first.next_cursor)
    last = await service.videos(principal(OWNER), limit=2, cursor=second.next_cursor)

    tail = first.items[-1]
    assert reports.queried[1][1] == VideoCursor(at=tail.face.finished_at, video_id=tail.id)
    assert first.total == 5 and second.total is None and last.total is None
    assert len(reports.counted) == 1
    seen = [item.id for page in (first, second, last) for item in page.items]
    assert len(seen) == len(set(seen)) == 5
    assert last.next_cursor is None


async def test_blank_keyword_means_no_keyword() -> None:
    reports = FakeReports()
    service = LibraryService(reports)

    await service.videos(principal(OWNER), q="   ")
    await service.videos(principal(OWNER), q=" 滑板 ")

    assert [scope.q for scope, _ in reports.queried] == [None, "滑板"]


async def test_bad_window_limit_and_cursor_are_rejected() -> None:
    service = LibraryService(FakeReports())

    with pytest.raises(ValidationFailed):
        await service.videos(principal(OWNER), since=NOW, until=NOW - timedelta(days=1))
    with pytest.raises(ValidationFailed):
        await service.videos(principal(OWNER), limit=0)
    with pytest.raises(ValidationFailed):
        await service.videos(principal(OWNER), cursor="not-a-cursor")
