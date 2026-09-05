"""外部数仓爆款榜与视频标签的只读查询，不建表、不迁移、不写入。

款号筛选必须使用 WMS 编号；排序与截断在数据库中执行，确保返回指定维度的前 N 条。"""

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
"""排序维度到可信 SQL 列名的映射；用户输入仅作为键，不直接拼入 SQL。"""

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
"""video_id 主键保证唯一性；作为次级排序键保证指标相同时截断结果稳定。"""


def _blank_to_none(value: str | None) -> str | None:
    """将上游空字符串视为缺失值。"""

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
