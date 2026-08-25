"""爆款视频的 wire 形状。字段名按跨端约定用 camelCase。"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Final

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.domains.inspirations.models import InspirationVideo, SortKey

MAX_STYLES_PER_SEARCH: Final = 20
"""一次最多问几个款。上限不是性能考虑——是让「把整个款库倒进来」这件事做不出来。"""

MAX_STYLE_CHARS: Final = 64
DEFAULT_LIMIT: Final = 50
MAX_LIMIT: Final = 100


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class VideoSearchIn(CamelModel):
    """按款搜爆款视频。

    ``style_wms_list`` 收的是 **WMS 编号**，不是 PDM 款号——名字里带着 ``wms`` 就是
    为了让传错的人在字段名上先愣一下：传成 PDM 款号会安静地搜不到任何东西。产品
    资料接口响应里的 ``styleWms`` 就是拿来喂这里的。
    """

    style_wms_list: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=MAX_STYLE_CHARS)]],
        Field(min_length=1, max_length=MAX_STYLES_PER_SEARCH),
    ]
    sort_by: SortKey = "orders"
    limit: Annotated[int, Field(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT


class MetricsOut(CamelModel):
    impressions: int
    views: int
    clicks: int
    orders: int
    revenue: Decimal


class PopularOut(CamelModel):
    """三种爆款标记彼此独立，可以同时成立。"""

    brand: bool
    kol: bool
    tt: bool


class VideoOut(CamelModel):
    video_id: str
    style_wms: str | None
    video_url: str
    oss_url: str | None
    creator_handle: str | None
    posted_date: str | None
    combat_team: str | None
    category: str | None
    metrics: MetricsOut
    popular: PopularOut


class VideoSearchOut(CamelModel):
    items: list[VideoOut]


def video_out(video: InspirationVideo) -> VideoOut:
    """领域形状 → wire 形状。"""

    return VideoOut(
        video_id=video.video_id,
        style_wms=video.style_wms,
        video_url=video.video_url,
        oss_url=video.oss_url,
        creator_handle=video.creator_handle,
        posted_date=video.posted_date,
        combat_team=video.combat_team,
        category=video.category,
        metrics=MetricsOut(
            impressions=video.metrics.impressions,
            views=video.metrics.views,
            clicks=video.metrics.clicks,
            orders=video.metrics.orders,
            revenue=video.metrics.revenue,
        ),
        popular=PopularOut(brand=video.popular.brand, kol=video.popular.kol, tt=video.popular.tt),
    )


__all__ = [
    "DEFAULT_LIMIT",
    "MAX_LIMIT",
    "MAX_STYLES_PER_SEARCH",
    "MAX_STYLE_CHARS",
    "MetricsOut",
    "PopularOut",
    "VideoOut",
    "VideoSearchIn",
    "VideoSearchOut",
    "video_out",
]
