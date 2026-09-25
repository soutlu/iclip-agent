"""资料库用例层：按读者裁来源对话、游标往返、总数只在第一页、参数校验。不连库。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal
from iclip.domains.library.models import Scope, VideoCursor
from iclip.domains.library.repository import CardRow
from iclip.domains.library.schemas import (
    FaceOut,
    LibraryAuthorOut,
    LibraryVideoOut,
    TakeOut,
)
from iclip.domains.library.service import LibraryService

NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)
OWNER = uuid.uuid4()


def principal(user_id: uuid.UUID, *permissions: str) -> Principal:
    return Principal(
        kind="user",
        user_id=user_id,
        permissions=frozenset({"generation:read", *permissions}),
        audit_label="someone",
    )


def take(video_id: uuid.UUID, at: datetime) -> TakeOut:
    return TakeOut(
        id=video_id,
        created_at=at,
        user_name="Nina.He",
        model="mmt-seedance-2-5",
        aspect_ratio="9:16",
        seconds=10,
        resolution="720p",
        generate_audio=False,
        output_url=f"https://oss.example.test/{video_id}.mp4",
        watermark_output_url=None,
        prompt="模特走向镜头。",
        script=None,
        reference_image_urls=[],
        masters=[],
    )


def card(at: datetime, *, conversation_owner: uuid.UUID | None = OWNER) -> CardRow:
    video_id = uuid.uuid4()
    return CardRow(
        video=LibraryVideoOut(
            id=video_id,
            shot_index=1,
            conversation_id=uuid.uuid4() if conversation_owner else None,
            title="春夏凉鞋合集",
            agent_id="storyboard",
            task_id=None,
            take_count=1,
            face=FaceOut(
                kind="take",
                job_id=video_id,
                output_url=f"https://oss.example.test/{video_id}.mp4",
                watermark_output_url=None,
                duration_ms=None,
                created_at=at,
            ),
            take=take(video_id, at),
        ),
        conversation_owner=conversation_owner,
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
        rows = sorted(self.cards, key=lambda row: (row.video.face.created_at, row.video.id))
        rows.reverse()
        if after is not None:
            key = (after.at, after.video_id)
            rows = [row for row in rows if (row.video.face.created_at, row.video.id) < key]
        return rows[:limit]

    async def count(self, scope: Scope) -> int:
        self.counted.append(scope)
        return len(self.cards)

    async def card_of(self, video_id: uuid.UUID) -> CardRow | None:
        return next((row for row in self.cards if row.video.id == video_id), None)

    async def takes_of(self, video_id: uuid.UUID) -> Sequence[TakeOut]:
        row = await self.card_of(video_id)
        return [] if row is None else [row.video.take]

    async def siblings_of(self, video_id: uuid.UUID) -> Sequence[CardRow]:
        return [row for row in self.cards if row.video.id != video_id]

    async def authors(self) -> Sequence[LibraryAuthorOut]:
        return [LibraryAuthorOut(user_name="Nina.He", count=len(self.cards))]


async def test_only_the_conversation_owner_and_governors_get_the_conversation() -> None:
    reports = FakeReports([card(NOW)])
    service = LibraryService(reports)

    as_owner = await service.videos(principal(OWNER))
    as_governor = await service.videos(principal(uuid.uuid4(), MANAGE_PERMISSION))
    as_colleague = await service.videos(principal(uuid.uuid4()))

    assert as_owner.items[0].conversation_id is not None
    assert as_governor.items[0].conversation_id == as_owner.items[0].conversation_id
    assert as_colleague.items[0].conversation_id is None
    # 片与脚本照样给，标题也照样给
    assert as_colleague.items[0].take == as_owner.items[0].take
    assert as_colleague.items[0].title == "春夏凉鞋合集"


async def test_detail_trims_the_conversation_on_the_card_and_its_siblings() -> None:
    first, second = card(NOW), card(NOW - timedelta(hours=1))
    service = LibraryService(FakeReports([first, second]))

    detail = await service.video(principal(uuid.uuid4()), first.video.id)

    assert detail.video.conversation_id is None
    assert [sibling.conversation_id for sibling in detail.siblings] == [None]
    assert detail.takes == [first.video.take]


async def test_a_video_outside_the_library_is_not_found() -> None:
    service = LibraryService(FakeReports([card(NOW)]))

    with pytest.raises(NotFound):
        await service.video(principal(OWNER), uuid.uuid4())


async def test_cursor_round_trips_and_total_is_only_on_the_first_page() -> None:
    reports = FakeReports([card(NOW - timedelta(minutes=minute)) for minute in range(5)])
    service = LibraryService(reports)

    first = await service.videos(principal(OWNER), limit=2)
    second = await service.videos(principal(OWNER), limit=2, cursor=first.next_cursor)
    last = await service.videos(principal(OWNER), limit=2, cursor=second.next_cursor)

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
