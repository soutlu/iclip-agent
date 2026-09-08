"""按 PDM 款号只读查询爆款视频，使用 assets:read 权限。

数据是随迁移灌入的快照，路由无条件挂载；没有可用参考时返回空列表，不是 404。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.inspirations.schemas import (
    VideoSearchIn,
    VideoSearchOut,
    filters_of,
    search_out,
)
from iclip.domains.inspirations.service import InspirationService


def create_inspirations_router(service: InspirationService) -> APIRouter:
    router = APIRouter(prefix="/inspirations", tags=["inspirations"])

    @router.post("/videos/search", response_model=VideoSearchOut)
    async def search_videos(
        body: VideoSearchIn,
        _principal: Annotated[Principal, Depends(require_permission("assets:read"))],
    ) -> VideoSearchOut:
        result = await service.search_videos(
            body.style_nos,
            filters=filters_of(body.filters),
            sort_by=body.sort_by,
            limit=body.limit,
        )
        return search_out(result)

    return router


__all__ = ["create_inspirations_router"]
