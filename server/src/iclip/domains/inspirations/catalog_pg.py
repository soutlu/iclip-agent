"""爆款视频库的只读后端：外部 Postgres（数仓的爆款榜 + 视频打标结果）。

**这些表不是我们的。** 本模块不建表、不迁移、不写入，只按显式列名读。上游改结构时
我们会响亮地失败，而不是悄悄返回半截数据。

两条不能改的口径：

- **按款过滤用的是 WMS 编号**，不是 PDM 款号。这不是选择：全库 287 个款号拿去比，
  按 WMS 编号命中 196 个，按 PDM 款号只命中 1 个。传错那一种的后果是静默返回空
  列表——所以入参名字里带着 ``wms``，让传错的人在字段名上就先愣一下。
- **排序在库里做，不在应用里做。** 一次二十个款能命中近千条视频，取的是那个维度上
  的前 N 条；捞回来再排等于换一批样本。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.inspirations.models import (
    InspirationVideo,
    PopularFlags,
    SortKey,
    VideoMetrics,
)

_SORT_COLUMNS: Final[dict[SortKey, str]] = {
    "impressions": "total_impressions",
    "views": "total_vv",
    "clicks": "total_clicks",
    "orders": "total_orders",
    "revenue": "video_revenue_amt",
}
"""排序维度 → 列名。**只有这张表里的值才会进 SQL**，调用方给的字符串永远只是键。"""

_STATS: Final = "video_labeling.dws_ttk_shop_bi_video_popular_tag_stats_df"
_VIDEOS: Final = "video_labeling.videos"

_SEARCH = """
SELECT s.video_id, s.style, s.video_url, s.posted_date, s.kol_name,
       s.total_impressions, s.total_vv, s.total_clicks, s.total_orders, s.video_revenue_amt,
       s.ct, s.product_category,
       s.is_brand_popular, s.is_kol_popular, s.is_tt_popular,
       v.oss_video_url
FROM {stats} s
LEFT JOIN {videos} v ON v.id = s.video_id
WHERE s.style = ANY(:styles)
ORDER BY s.{column} DESC, s.video_id
LIMIT :limit
"""
"""``video_id`` 是这张表的主键，所以一条视频只有一行，不需要去重。

排序尾巴上跟一个 ``video_id``：指标持平时得有个确定的先后，否则同样的请求两次
可能给出不同的截断结果。
"""


def _blank_to_none(value: str | None) -> str | None:
    """上游的空串等于没填。"""

    return value.strip() or None if value else None


class PgInspirationCatalog:
    """按 WMS 编号查这些款的爆款视频，服务端按指定维度取 top-N。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def search(
        self, style_wms_list: Sequence[str], *, sort_by: SortKey, limit: int
    ) -> tuple[InspirationVideo, ...]:
        statement = text(
            _SEARCH.format(stats=_STATS, videos=_VIDEOS, column=_SORT_COLUMNS[sort_by])
        )
        async with self._engine.connect() as conn:
            rows = (
                (await conn.execute(statement, {"styles": list(style_wms_list), "limit": limit}))
                .mappings()
                .all()
            )
        return tuple(
            InspirationVideo(
                video_id=row["video_id"],
                style_wms=_blank_to_none(row["style"]),
                video_url=row["video_url"],
                oss_url=_blank_to_none(row["oss_video_url"]),
                creator_handle=_blank_to_none(row["kol_name"]),
                posted_date=_blank_to_none(row["posted_date"]),
                combat_team=_blank_to_none(row["ct"]),
                category=_blank_to_none(row["product_category"]),
                metrics=VideoMetrics(
                    impressions=row["total_impressions"],
                    views=row["total_vv"],
                    clicks=row["total_clicks"],
                    orders=row["total_orders"],
                    revenue=row["video_revenue_amt"],
                ),
                popular=PopularFlags(
                    brand=bool(row["is_brand_popular"]),
                    kol=bool(row["is_kol_popular"]),
                    tt=bool(row["is_tt_popular"]),
                ),
            )
            for row in rows
        )


__all__ = ["PgInspirationCatalog"]
