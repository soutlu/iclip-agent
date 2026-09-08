"""爆款视频的 wire 形状。字段名按跨端约定用 camelCase。"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Final

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.domains.inspirations.models import (
    MatchLevel,
    MetricFilters,
    SortKey,
    VideoSearchResult,
)

MAX_STYLES_PER_SEARCH: Final = 20
"""一次最多问几个款。上限不是性能考虑——是让「把整个款库倒进来」这件事做不出来。"""

MAX_STYLE_CHARS: Final = 64
DEFAULT_LIMIT: Final = 50
MAX_LIMIT: Final = 100


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class MetricFiltersIn(CamelModel):
    """表现下限，全部可选；省略的维度不设限。

    门槛只筛最终结果：把结果筛空不会让这个款被判为「没有视频」，也就不会因此降级。
    """

    min_impressions: Annotated[int | None, Field(ge=0)] = None
    min_views: Annotated[int | None, Field(ge=0)] = None
    min_clicks: Annotated[int | None, Field(ge=0)] = None
    min_orders: Annotated[int | None, Field(ge=0)] = None
    min_revenue: Annotated[Decimal | None, Field(ge=0)] = None


class VideoSearchIn(CamelModel):
    """按款搜爆款视频。

    ``style_nos`` 收的是 **PDM 款号**，与产品资料接口的查询键同源；WMS 编号只在数据
    入库时用于对齐数仓，调用方不接触。
    """

    style_nos: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=MAX_STYLE_CHARS)]],
        Field(min_length=1, max_length=MAX_STYLES_PER_SEARCH),
    ]
    filters: MetricFiltersIn = MetricFiltersIn()
    sort_by: SortKey = "orders"
    limit: Annotated[int, Field(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT


class StyleMatchOut(CamelModel):
    """一个入参款落在哪一级。除 ``exact`` 外，属于这个款的结果都是替身。"""

    style_no: str
    match_level: MatchLevel


class VideoSearchOut(CamelModel):
    """可下载地址按所选维度降序；``matches`` 逐款说明结果的来源层级。"""

    video_urls: list[str]
    matches: list[StyleMatchOut]


def filters_of(body: MetricFiltersIn) -> MetricFilters:
    """wire 形状 → 领域形状。"""

    return MetricFilters(
        min_impressions=body.min_impressions,
        min_views=body.min_views,
        min_clicks=body.min_clicks,
        min_orders=body.min_orders,
        min_revenue=body.min_revenue,
    )


def search_out(result: VideoSearchResult) -> VideoSearchOut:
    """领域形状 → wire 形状。"""

    return VideoSearchOut(
        video_urls=list(result.oss_urls),
        matches=[
            StyleMatchOut(style_no=match.style_no, match_level=match.match_level)
            for match in result.matches
        ],
    )


__all__ = [
    "DEFAULT_LIMIT",
    "MAX_LIMIT",
    "MAX_STYLES_PER_SEARCH",
    "MAX_STYLE_CHARS",
    "MetricFiltersIn",
    "StyleMatchOut",
    "VideoSearchIn",
    "VideoSearchOut",
    "filters_of",
    "search_out",
]
