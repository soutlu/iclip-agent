"""按 WMS 编号只读查询爆款视频，使用 assets:read 权限。

POST 请求体承载批量款号与排序维度；爆款库未配置时不挂载路由。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.inspirations.catalog_pg import PgInspirationCatalog
from iclip.domains.inspirations.schemas import VideoSearchIn, VideoSearchOut, video_out


def create_inspirations_router(catalog: PgInspirationCatalog) -> APIRouter:
    router = APIRouter(prefix="/inspirations", tags=["inspirations"])

    @router.post("/videos/search", response_model=VideoSearchOut)
    async def search_videos(
        body: VideoSearchIn,
        _principal: Annotated[Principal, Depends(require_permission("assets:read"))],
    ) -> VideoSearchOut:
        found = await catalog.search(body.style_wms_list, sort_by=body.sort_by, limit=body.limit)
        return VideoSearchOut(items=[video_out(video) for video in found])

    return router


__all__ = ["create_inspirations_router"]
