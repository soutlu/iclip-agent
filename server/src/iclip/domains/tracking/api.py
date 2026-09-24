"""埋点 HTTP 端点。只收事件、不回内容，要 ``generation:read``。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.tracking.schemas import TrackingEventIn
from iclip.domains.tracking.service import TrackingService


def create_tracking_router(service: TrackingService) -> APIRouter:
    router = APIRouter(prefix="/tracking", tags=["tracking"])

    @router.post("/events", status_code=204)
    async def record_event(
        principal: Annotated[Principal, require_permission("generation:read")],
        body: TrackingEventIn,
    ) -> None:
        """记一条事件。发起人取自凭证，发生时刻取服务端时钟。

        ``video.downloaded`` 必带 ``jobId``、不带 ``conversationId``，缺了或多带是 ``422``；
        ``jobId`` 须是一条成功、有地址的独立视频或成片，不存在与不合格同样是 ``404``。
        """

        await service.record(principal, body)

    return router


__all__ = ["create_tracking_router"]
