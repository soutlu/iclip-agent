"""爆款视频领域模型。

一个款自己有没有爆款视频是稀缺的：全量在架款里只有约 3% 命中。因此「这个款没有
视频就退到同品牌同类目、再退到同类目」不是兜底分支，而是绝大多数请求实际走的
主路径——匹配层级必须随结果一起交给调用方，否则它分不清手里的链接是本款的还是
替身的。"""

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
class StyleGroup:
    """一个款在 PDM 中的品类与品牌，降级时按这两维逐级放宽。"""

    category_id: int
    brand_code: str


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
    "StyleGroup",
    "StyleMatch",
    "VideoSearchResult",
]
