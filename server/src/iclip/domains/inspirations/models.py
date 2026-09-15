"""爆款视频领域模型。

本款没有视频时，按同品牌同类目、同类目逐级取替身。
匹配层级随结果返回，供调用方区分本款视频与替身。"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

SortKey = Literal["impressions", "views", "clicks", "orders", "revenue"]
"""排序维度的封闭枚举，经受控映射选择 SQL 列。"""

MatchLevel = Literal["exact", "sameBrandCategory", "sameCategory", "none"]
"""一个入参款最终落在哪一级：本款自己的视频，还是同品牌同类目／同类目的替身。"""


@dataclass(frozen=True, slots=True)
class MetricFilters:
    """视频表现下限，全部可选；``None`` 表示这一维不设限。

    门槛只筛最终结果，不参与「这个款有没有视频」的判定：门槛把结果筛空不等于这个
    款没有视频，因此不触发降级。
    """

    min_impressions: int | None = None
    min_views: int | None = None
    min_clicks: int | None = None
    min_orders: int | None = None
    min_revenue: Decimal | None = None


@dataclass(frozen=True, slots=True)
class StyleMatch:
    """一个入参款最终选择的匹配层级。"""

    style_no: str
    match_level: MatchLevel


@dataclass(frozen=True, slots=True)
class VideoSearchResult:
    """一次查询的结果：可下载地址按所选维度降序，以及逐款的匹配层级。"""

    oss_urls: tuple[str, ...]
    matches: tuple[StyleMatch, ...]


__all__ = [
    "MatchLevel",
    "MetricFilters",
    "SortKey",
    "StyleMatch",
    "VideoSearchResult",
]
