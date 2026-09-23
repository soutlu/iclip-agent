"""爆款视频查询的测试数据：登记款的品类品牌、插入视频快照、按 video_id 推出默认地址。"""

from __future__ import annotations

import datetime as dt
from collections.abc import Sequence
from decimal import Decimal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

_INSERT_STYLE = text(
    "INSERT INTO pdm_styles"
    " (pdm_entity_id, product_number, style_wms, source_status,"
    "  product_category_id, brand)"
    " VALUES (:entity_id, :style_no, :style_no, 'effective', :category_id, :brand_code)"
)

_INSERT_VIDEO = text(
    "INSERT INTO iclip.inspiration_videos"
    " (video_id, style_raw, style_no, category_id, category_name,"
    "  brand_code, brand_name, oss_url, posted_date,"
    "  impressions, views, clicks, orders, revenue)"
    " VALUES (:video_id, :style_raw, :style_no, :category_id, :category_name,"
    "         :brand_code, :brand_name, :oss_url, :posted_date,"
    "         :impressions, :views, :clicks, :orders, :revenue)"
)


async def seed_style(
    engine: AsyncEngine,
    *,
    style_no: str,
    category_id: int | None = 70,
    brand_code: str | None = "3",
    entity_id: int | None = None,
) -> None:
    """登记一个款的品类与品牌归属。``None`` 表示上游缺这一项。"""

    async with engine.begin() as conn:
        await conn.execute(
            _INSERT_STYLE,
            {
                "entity_id": entity_id if entity_id is not None else abs(hash(style_no)) % 10**9,
                "style_no": style_no,
                "category_id": category_id,
                "brand_code": brand_code,
            },
        )


async def seed_video(
    engine: AsyncEngine,
    *,
    video_id: str,
    style_no: str,
    category_id: int = 70,
    brand_code: str = "3",
    brand_name: str = "NORTIV8",
    category_name: str = "跑鞋",
    oss_url: str | None = None,
    style_raw: str | None = None,
    posted_date: str = "2026-06-24",
    impressions: int = 100,
    views: int = 0,
    clicks: int = 3,
    orders: int = 0,
    revenue: str = "0",
) -> None:
    """插入一条可下载的爆款视频。"""

    async with engine.begin() as conn:
        await conn.execute(
            _INSERT_VIDEO,
            {
                "video_id": video_id,
                "style_raw": style_raw if style_raw is not None else style_no,
                "style_no": style_no,
                "category_id": category_id,
                "category_name": category_name,
                "brand_code": brand_code,
                "brand_name": brand_name,
                "oss_url": oss_url or f"https://bucket.example.com/{video_id}.mp4",
                "posted_date": dt.date.fromisoformat(posted_date),
                "impressions": impressions,
                "views": views,
                "clicks": clicks,
                "orders": orders,
                "revenue": Decimal(revenue),
            },
        )


def urls_of(video_ids: Sequence[str]) -> list[str]:
    """按 video_id 拼出 seed_video 默认使用的地址，供断言比对顺序。"""

    return [f"https://bucket.example.com/{video_id}.mp4" for video_id in video_ids]


__all__ = ["seed_style", "seed_video", "urls_of"]
