"""爆款视频查询的 HTTP 面：一个端点，按款搜，零副作用。

权限用 ``assets:read``，和产品资料查询同一个口径——挑参考素材和「能读东西」是同
一件事，三个预置角色都已经有它。

用 POST 而不是 GET：入参是一组款号加排序维度，放请求体里能被类型挡住（排序维度是
封闭枚举、款号有条数和长度上限）。这一步只读，不写任何东西。

没配爆款库时整个路由不挂载（同 SSO、媒体生成的口径）。
"""

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
