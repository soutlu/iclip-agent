"""爆款视频的领域形状。

指标原样带出来，不换算也不合成综合分：哪个维度算「爆」是调用方的判断，我们只
负责把上游记的数字如实交出去。
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

SortKey = Literal["impressions", "views", "clicks", "orders", "revenue"]
"""按哪个维度取 top-N。封闭枚举——它要变成 SQL 里的列名，绝不能让调用方的字符串直达。"""


@dataclass(frozen=True, slots=True)
class VideoMetrics:
    """一条视频的表现。``revenue`` 保持 ``Decimal``：它是钱，不走浮点。"""

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
    """一条爆款视频。

    ``style_wms`` 是它关联的款——**那是 WMS 编号，不是 PDM 款号**，两套编码不通用。
    ``category`` 是平台口径的英文类目（``Casual Trainers`` 这种），和产品资料里那套
    PDM 品类不是一回事，两边各说各的、不互相翻译。
    """

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
