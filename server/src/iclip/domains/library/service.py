"""资料库用例：整理筛选范围与游标，并按读者裁掉来源对话。端点权限由路由声明。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal
from iclip.domains.library.models import Orientation, Scope, VideoCursor
from iclip.domains.library.repository import CardRow, LibraryReports
from iclip.domains.library.schemas import (
    LibraryAuthorsOut,
    LibraryVideoDetailOut,
    LibraryVideoOut,
    LibraryVideosOut,
)
from iclip.platform.paging import check_limit, decode_cursor, encode_cursor


def _as_utc(moment: datetime | None) -> datetime | None:
    """无时区输入按 UTC 解释，避免与 timestamptz 比较时驱动报错。"""

    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _scope(
    *,
    user_name: str | None,
    since: datetime | None,
    until: datetime | None,
    orientation: Orientation | None,
    q: str | None,
) -> Scope:
    since, until = _as_utc(since), _as_utc(until)
    if since is not None and until is not None and since >= until:
        raise ValidationFailed("since 必须早于 until")
    keyword = q.strip() if q is not None else ""
    return Scope(
        user_name=user_name,
        since=since,
        until=until,
        orientation=orientation,
        q=keyword or None,
    )


def _after(cursor: str | None) -> VideoCursor | None:
    if cursor is None:
        return None
    parsed = decode_cursor(cursor)
    return VideoCursor(at=parsed.at, video_id=parsed.uuid_key())


def _for_reader(principal: Principal, row: CardRow) -> LibraryVideoOut:
    """来源对话只交给对话属主与治理者；其余人看得到片与脚本，拿不到对话。"""

    if row.conversation_owner == principal.user_id or principal.has(MANAGE_PERMISSION):
        return row.video
    return row.video.model_copy(update={"conversation_id": None})


class LibraryService:
    def __init__(self, reports: LibraryReports) -> None:
        self._reports = reports

    async def videos(
        self,
        principal: Principal,
        *,
        user_name: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        orientation: Orientation | None = None,
        q: str | None = None,
        limit: int = 20,
        cursor: str | None = None,
    ) -> LibraryVideosOut:
        """卡面时刻晚的排前面；满页才给下一页游标，总数只在第一页给。"""

        check_limit(limit)
        scope = _scope(user_name=user_name, since=since, until=until, orientation=orientation, q=q)
        after = _after(cursor)
        rows = await self._reports.videos(scope, limit=limit, after=after)
        next_cursor = None
        if len(rows) == limit:
            last = rows[-1].video
            next_cursor = encode_cursor(last.face.created_at, last.id)
        total = await self._reports.count(scope) if after is None else None
        return LibraryVideosOut(
            items=[_for_reader(principal, row) for row in rows],
            next_cursor=next_cursor,
            total=total,
        )

    async def video(self, principal: Principal, video_id: uuid.UUID) -> LibraryVideoDetailOut:
        """一镜的详情；这次出片不在资料库里就是 ``NotFound``。"""

        row = await self._reports.card_of(video_id)
        if row is None:
            raise NotFound("资料库里没有这条视频")
        takes = await self._reports.takes_of(video_id)
        siblings = await self._reports.siblings_of(video_id)
        return LibraryVideoDetailOut(
            video=_for_reader(principal, row),
            takes=list(takes),
            siblings=[_for_reader(principal, sibling) for sibling in siblings],
        )

    async def authors(self) -> LibraryAuthorsOut:
        return LibraryAuthorsOut(items=list(await self._reports.authors()))


__all__ = ["LibraryService"]
