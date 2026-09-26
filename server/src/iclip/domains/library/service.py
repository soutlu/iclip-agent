"""资料库用例：整理筛选范围与游标，并按读者算能不能打开来源对话。端点权限由路由声明。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal, visible_owner_incl_act_as
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


def _can_open(principal: Principal, row: CardRow) -> bool:
    """口径同对话的读路径：治理者读得到任何对话，含墓碑；其余人要对话没删，且是属主或持
    ``users:act_as`` 的钥匙。不挂对话的卡没有对话可开。"""

    if row.video.conversation_id is None:
        return False
    if principal.has(MANAGE_PERMISSION):
        return True
    owner = visible_owner_incl_act_as(principal)
    return not row.conversation_deleted and (owner is None or owner == row.conversation_owner)


def _for_reader(principal: Principal, row: CardRow) -> LibraryVideoOut:
    return row.video.model_copy(update={"can_open_conversation": _can_open(principal, row)})


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
        """卡面完成时刻晚的排前面；满页才给下一页游标，总数只在第一页给。"""

        check_limit(limit)
        scope = _scope(user_name=user_name, since=since, until=until, orientation=orientation, q=q)
        after = _after(cursor)
        rows = await self._reports.videos(scope, limit=limit, after=after)
        next_cursor = None
        if len(rows) == limit:
            last = rows[-1].video
            next_cursor = encode_cursor(last.face.finished_at, last.id)
        total = await self._reports.count(scope) if after is None else None
        return LibraryVideosOut(
            items=[_for_reader(principal, row) for row in rows],
            next_cursor=next_cursor,
            total=total,
        )

    async def video(self, principal: Principal, card_id: uuid.UUID) -> LibraryVideoDetailOut:
        """一张卡的详情；``card_id`` 不是卡 id 就是 ``NotFound``。对话删了照常返回。"""

        row = await self._reports.card_of(card_id)
        if row is None:
            raise NotFound("资料库里没有这条视频")
        groups = await self._reports.groups_of(card_id)
        return LibraryVideoDetailOut(video=_for_reader(principal, row), groups=list(groups))

    async def authors(self) -> LibraryAuthorsOut:
        return LibraryAuthorsOut(items=list(await self._reports.authors()))


__all__ = ["LibraryService"]
