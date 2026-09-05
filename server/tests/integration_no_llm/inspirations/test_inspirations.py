"""验证爆款视频 HTTP 契约、编码过滤、数据库排序和排序键白名单。"""

from __future__ import annotations

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.integration_no_llm.conftest import register_and_login

URL = "/inspirations/videos/search"
STYLE = "SNMT241M"

_INSERT = text(
    "INSERT INTO video_labeling.dws_ttk_shop_bi_video_popular_tag_stats_df"
    " (video_id, posted_date, video_url, kol_name, style, ct, product_category,"
    "  total_impressions, total_vv, total_clicks, total_orders, video_revenue_amt,"
    "  is_brand_popular, is_kol_popular, is_tt_popular)"
    " VALUES (:video_id, :posted_date, :video_url, :kol_name, :style, :ct, :category,"
    "  :impressions, :views, :clicks, :orders, :revenue, :brand, :kol, :tt)"
)


async def seed_video(
    engine: AsyncEngine,
    *,
    video_id: str,
    style: str = STYLE,
    orders: int = 0,
    views: int = 0,
    revenue: str = "0",
    oss_url: str | None = None,
    ct: str | None = "Nortiv8",
    category: str | None = "Work & Safety Footwear",
    kol_name: str | None = "fraw_berry",
    brand: int = 0,
    kol: int = 0,
    tt: int = 1,
) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            _INSERT,
            {
                "video_id": video_id,
                "posted_date": "2025-06-24",
                "video_url": f"https://www.tiktok.com/@x/video/{video_id}",
                "kol_name": kol_name,
                "style": style,
                "ct": ct,
                "category": category,
                "impressions": 100,
                "views": views,
                "clicks": 3,
                "orders": orders,
                "revenue": revenue,
                "brand": brand,
                "kol": kol,
                "tt": tt,
            },
        )
        if oss_url is not None:
            await conn.execute(
                text("INSERT INTO video_labeling.videos (id, oss_video_url) VALUES (:id, :url)"),
                {"id": video_id, "url": oss_url},
            )


async def search(client: httpx.AsyncClient, **body: object) -> httpx.Response:
    return await client.post(URL, json={"styleWmsList": [STYLE], **body})


async def test_anonymous_is_rejected(client: httpx.AsyncClient) -> None:
    assert (await search(client)).status_code == 401


async def test_no_match_is_an_empty_list(client: httpx.AsyncClient) -> None:

    await register_and_login(client)

    found = await search(client)

    assert (found.status_code, found.json()) == (200, {"items": []})


async def test_returns_metrics_flags_and_playable_url(
    client: httpx.AsyncClient, inspiration_engine: AsyncEngine
) -> None:
    await register_and_login(client)
    await seed_video(
        inspiration_engine,
        video_id="7519657364165856542",
        orders=56,
        views=152446,
        revenue="3171.510000",
        oss_url="https://bucket.example.com/a.mp4",
        brand=1,
    )

    item = (await search(client)).json()["items"][0]

    assert item["videoId"] == "7519657364165856542"
    # 此接口使用 WMS 编号，与产品接口的 styleNo 不同。
    assert item["styleWms"] == STYLE
    assert item["ossUrl"] == "https://bucket.example.com/a.mp4"
    assert item["combatTeam"] == "Nortiv8"
    # 平台类目与 PDM 品类属于不同编码体系。
    assert item["category"] == "Work & Safety Footwear"
    assert item["metrics"]["orders"] == 56
    assert item["metrics"]["views"] == 152446
    assert item["metrics"]["revenue"] == "3171.510000"
    assert item["popular"] == {"brand": True, "kol": False, "tt": True}


async def test_video_without_a_mirrored_copy_still_comes_back(
    client: httpx.AsyncClient, inspiration_engine: AsyncEngine
) -> None:
    """部分视频没有转存副本，仍须返回原始地址。"""

    await register_and_login(client)
    await seed_video(inspiration_engine, video_id="1", oss_url=None)

    item = (await search(client)).json()["items"][0]

    assert item["ossUrl"] is None
    assert item["videoUrl"].endswith("/1")


async def test_top_n_is_taken_in_the_database(
    client: httpx.AsyncClient, inspiration_engine: AsyncEngine
) -> None:
    """排序必须先于截断，避免应用层重排改变样本集合。"""

    await register_and_login(client)
    for index in range(5):
        await seed_video(inspiration_engine, video_id=str(index), orders=index, views=100 - index)

    by_orders = (await search(client, sortBy="orders", limit=2)).json()["items"]
    by_views = (await search(client, sortBy="views", limit=2)).json()["items"]

    assert [item["videoId"] for item in by_orders] == ["4", "3"]
    assert [item["videoId"] for item in by_views] == ["0", "1"]


async def test_other_styles_are_not_returned(
    client: httpx.AsyncClient, inspiration_engine: AsyncEngine
) -> None:
    await register_and_login(client)
    await seed_video(inspiration_engine, video_id="mine", style=STYLE)
    await seed_video(inspiration_engine, video_id="theirs", style="OTHER")

    items = (await search(client)).json()["items"]

    assert [item["videoId"] for item in items] == ["mine"]


async def test_sort_key_is_a_closed_enum(client: httpx.AsyncClient) -> None:
    """排序键参与 SQL 列名选择，仅接受白名单。"""

    await register_and_login(client)

    assert (await search(client, sortBy="video_id; DROP TABLE videos")).status_code == 422
    assert (await search(client, sortBy="revenue")).status_code == 200


async def test_request_shape_is_bounded(client: httpx.AsyncClient) -> None:
    await register_and_login(client)

    assert (await client.post(URL, json={"styleWmsList": []})).status_code == 422
    assert (await client.post(URL, json={"styleWmsList": ["x"] * 21})).status_code == 422
    assert (await search(client, limit=0)).status_code == 422
    assert (await search(client, limit=101)).status_code == 422


async def test_not_mounted_without_the_catalog(app_without_inspirations: FastAPI) -> None:
    """检查路由表以区分未挂载与无查询结果。"""

    assert app_without_inspirations.state.inspirations is None
    assert not [
        route
        for route in app_without_inspirations.routes
        if getattr(route, "path", "").startswith("/inspirations")
    ]
