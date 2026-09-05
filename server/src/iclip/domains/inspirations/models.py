"""爆款视频领域模型，保留上游原始指标，不合成综合分。"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

SortKey = Literal["impressions", "views", "clicks", "orders", "revenue"]
"""排序维度的封闭枚举，经受控映射选择 SQL 列。"""


@dataclass(frozen=True, slots=True)
class VideoMetrics:
    """视频表现指标；revenue 使用 Decimal 保持金额精度。"""

    impressions: int
    views: int
    clicks: int
    orders: int
    revenue: Decimal


@dataclass(frozen=True, slots=True)
class PopularFlags:
    """上游给这条视频打的三种爆款标记，彼此独立、可以同时成立。"""

    brand: bool
    kol: bool
    tt: bool


@dataclass(frozen=True, slots=True)
class InspirationVideo:
    """爆款视频。style_wms 使用 WMS 编号；category 为平台类目，与 PDM 品类独立。"""

    video_id: str
    style_wms: str | None
    video_url: str
    oss_url: str | None
    creator_handle: str | None
    posted_date: str | None
    combat_team: str | None
    category: str | None
    metrics: VideoMetrics
    popular: PopularFlags


__all__ = ["InspirationVideo", "PopularFlags", "SortKey", "VideoMetrics"]
