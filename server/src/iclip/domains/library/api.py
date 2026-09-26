"""资料库 HTTP 端点。三个只读口都要 ``generation:read``，收录口径与可见范围见合同 §13。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.library.models import Orientation
from iclip.domains.library.schemas import (
    LibraryAuthorsOut,
    LibraryVideoDetailOut,
    LibraryVideosOut,
)
from iclip.domains.library.service import LibraryService
from iclip.platform.paging import DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT


def create_library_router(service: LibraryService) -> APIRouter:
    router = APIRouter(prefix="/library", tags=["library"])

    @router.get("/videos", response_model=LibraryVideosOut)
    async def videos(
        principal: Annotated[Principal, require_permission("generation:read")],
        user_name: Annotated[str | None, Query(alias="userName", max_length=150)] = None,
        since: datetime | None = None,
        until: datetime | None = None,
        orientation: Orientation | None = None,
        q: Annotated[str | None, Query(max_length=100)] = None,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> LibraryVideosOut:
        """全站的成片，一段对话一张卡，卡面成片完成得晚的排前面。

        ``userName`` 筛卡的作者（对话属主）；时间窗 ``[since, until)`` 作用在卡面成片的完成时刻上；
        ``q`` 按字面包含匹配卡面成片对应那条出片的正文与对话标题。``total`` 只在第一页给。
        来源对话人人拿得到，``canOpenConversation`` 说这位读者打不打得开。
        """

        return await service.videos(
            principal,
            user_name=user_name,
            since=since,
            until=until,
            orientation=orientation,
            q=q,
            limit=limit,
            cursor=cursor,
        )

    @router.get("/videos/{video_id}", response_model=LibraryVideoDetailOut)
    async def video(
        principal: Annotated[Principal, require_permission("generation:read")],
        video_id: uuid.UUID,
    ) -> LibraryVideoDetailOut:
        """一张卡：卡片本身与按镜头组分好的全部版本，含继承来的。

        ``video_id`` 是卡 id（对话 id，不挂对话的卡是出片 id），别的 id 一律 ``404``；
        对话删了照常返回。
        """

        return await service.video(principal, video_id)

    @router.get("/authors", response_model=LibraryAuthorsOut)
    async def authors(
        _: Annotated[Principal, require_permission("generation:read")],
    ) -> LibraryAuthorsOut:
        """卡的作者与各自的卡数，多的排前面；给按人筛选用。"""

        return await service.authors()

    return router


__all__ = ["create_library_router"]
