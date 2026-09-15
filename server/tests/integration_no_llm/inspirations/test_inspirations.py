"""验证爆款视频 HTTP 契约、降级分级、门槛语义与库内排序。"""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.integration_no_llm.conftest import register_and_login
from tests.integration_no_llm.inspirations.conftest import seed_style, seed_video, urls_of

URL = "/inspirations/videos/search"
STYLE = "SNMT241M"
RUNNING = 70
BOOTS = 88
NORTIV8 = "3"
BRUNO = "1"


async def search(client: httpx.AsyncClient, **body: object) -> httpx.Response:
    return await client.post(URL, json={"styleNos": [STYLE], **body})


async def test_anonymous_is_rejected(client: httpx.AsyncClient) -> None:
    assert (await search(client)).status_code == 401


async def test_unknown_style_is_none_not_an_error(client: httpx.AsyncClient) -> None:
    """款号在产品资料里查不到时不是错误，只是这次没有可用参考。"""

    await register_and_login(client)

    found = await search(client)

    assert found.status_code == 200
    assert found.json() == {
        "videoUrls": [],
        "matches": [{"styleNo": STYLE, "matchLevel": "none"}],
    }


async def test_exact_match_returns_own_videos(
    client: httpx.AsyncClient, business_engine: AsyncEngine, catalog_engine: AsyncEngine
) -> None:
    await register_and_login(client)
    await seed_style(catalog_engine, style_no=STYLE)
    await seed_video(business_engine, video_id="101", style_no=STYLE, orders=56)

    found = (await search(client)).json()

    assert found["videoUrls"] == urls_of(["101"])
    assert found["matches"] == [{"styleNo": STYLE, "matchLevel": "exact"}]


async def test_falls_back_to_same_brand_and_category(
    client: httpx.AsyncClient, business_engine: AsyncEngine, catalog_engine: AsyncEngine
) -> None:
    """本款没有视频时，优先拿同品牌同类目的替身。"""

    await register_and_login(client)
    await seed_style(catalog_engine, style_no=STYLE, category_id=RUNNING, brand_code=NORTIV8)
    await seed_video(
        business_engine,
        video_id="201",
        style_no="OTHER-NORTIV8",
        category_id=RUNNING,
        brand_code=NORTIV8,
    )
    await seed_video(
        business_engine,
        video_id="202",
        style_no="OTHER-BRUNO",
        category_id=RUNNING,
        brand_code=BRUNO,
        orders=999,
    )

    found = (await search(client)).json()

    assert found["matches"] == [{"styleNo": STYLE, "matchLevel": "sameBrandCategory"}]
    # 同类目里指标更高的别家品牌不参与：这一级只放同品牌。
    assert found["videoUrls"] == urls_of(["201"])


async def test_falls_back_to_same_category(
    client: httpx.AsyncClient, business_engine: AsyncEngine, catalog_engine: AsyncEngine
) -> None:
    """同品牌同类目没有视频时，再退一级到同类目。"""

    await register_and_login(client)
    await seed_style(catalog_engine, style_no=STYLE, category_id=RUNNING, brand_code=NORTIV8)
    await seed_video(
        business_engine,
        video_id="301",
        style_no="OTHER-BRUNO",
        category_id=RUNNING,
        brand_code=BRUNO,
    )

    found = (await search(client)).json()

    assert found["matches"] == [{"styleNo": STYLE, "matchLevel": "sameCategory"}]
    assert found["videoUrls"] == urls_of(["301"])


async def test_none_when_the_whole_category_has_no_videos(
    client: httpx.AsyncClient, business_engine: AsyncEngine, catalog_engine: AsyncEngine
) -> None:
    await register_and_login(client)
    await seed_style(catalog_engine, style_no=STYLE, category_id=RUNNING, brand_code=NORTIV8)
    await seed_video(
        business_engine, video_id="401", style_no="ELSEWHERE", category_id=BOOTS, brand_code=NORTIV8
    )

    found = (await search(client)).json()

    assert found == {"videoUrls": [], "matches": [{"styleNo": STYLE, "matchLevel": "none"}]}


async def test_style_without_a_category_cannot_fall_back(
    client: httpx.AsyncClient, business_engine: AsyncEngine, catalog_engine: AsyncEngine
) -> None:
    """上游没给品类的款无从圈选同类款，落到 none 而不是拿全库凑数。"""

    await register_and_login(client)
    await seed_style(catalog_engine, style_no=STYLE, category_id=None)
    await seed_video(business_engine, video_id="501", style_no="OTHER", category_id=RUNNING)

    found = (await search(client)).json()

    assert found == {"videoUrls": [], "matches": [{"styleNo": STYLE, "matchLevel": "none"}]}


@pytest.mark.parametrize(
    ("matched_style", "match_level"),
    [(STYLE, "exact"), ("OTHER-NORTIV8", "sameBrandCategory")],
)
async def test_thresholds_do_not_change_match_level(
    client: httpx.AsyncClient,
    business_engine: AsyncEngine,
    catalog_engine: AsyncEngine,
    matched_style: str,
    match_level: str,
) -> None:
    """门槛筛空本款或同品牌候选，都不再放宽到指标更高的其他品牌。"""

    await register_and_login(client)
    await seed_style(catalog_engine, style_no=STYLE, category_id=RUNNING, brand_code=NORTIV8)
    await seed_video(business_engine, video_id="601", style_no=matched_style, orders=1)
    await seed_video(
        business_engine,
        video_id="602",
        style_no="OTHER-BRUNO",
        category_id=RUNNING,
        brand_code=BRUNO,
        orders=500,
    )

    found = (await search(client, filters={"minOrders": 100})).json()

    assert found["matches"] == [{"styleNo": STYLE, "matchLevel": match_level}]
    assert found["videoUrls"] == []


async def test_thresholds_filter_the_result(
    client: httpx.AsyncClient, business_engine: AsyncEngine, catalog_engine: AsyncEngine
) -> None:
    await register_and_login(client)
    await seed_style(catalog_engine, style_no=STYLE)
    await seed_video(business_engine, video_id="701", style_no=STYLE, orders=5, revenue="10.5")
    await seed_video(business_engine, video_id="702", style_no=STYLE, orders=50, revenue="900.25")

    found = (await search(client, filters={"minOrders": 10, "minRevenue": "100"})).json()

    assert found["videoUrls"] == urls_of(["702"])


async def test_exact_and_fallback_scopes_share_one_deduplicated_top_n(
    client: httpx.AsyncClient, business_engine: AsyncEngine, catalog_engine: AsyncEngine
) -> None:
    """本款与两级替身范围重叠时，视频去重后共享排序和 limit。"""

    await register_and_login(client)
    await seed_style(catalog_engine, style_no=STYLE, category_id=RUNNING, brand_code=NORTIV8)
    await seed_style(
        catalog_engine, style_no="NO-OWN-NORTIV8", category_id=RUNNING, brand_code=NORTIV8
    )
    await seed_style(catalog_engine, style_no="NO-OWN-BRUNO", category_id=RUNNING, brand_code=BRUNO)
    await seed_video(business_engine, video_id="801", style_no=STYLE, orders=20)
    await seed_video(business_engine, video_id="802", style_no="OTHER-NORTIV8", orders=30)
    await seed_video(business_engine, video_id="803", style_no="OTHER-NORTIV8", orders=10)

    found = (
        await client.post(
            URL,
            json={"styleNos": [STYLE, "NO-OWN-NORTIV8", "NO-OWN-BRUNO", STYLE], "limit": 2},
        )
    ).json()

    assert found["videoUrls"] == urls_of(["802", "801"])
    assert found["matches"] == [
        {"styleNo": STYLE, "matchLevel": "exact"},
        {"styleNo": "NO-OWN-NORTIV8", "matchLevel": "sameBrandCategory"},
        {"styleNo": "NO-OWN-BRUNO", "matchLevel": "sameCategory"},
    ]


async def test_sort_by_selects_a_different_sample(
    client: httpx.AsyncClient, business_engine: AsyncEngine, catalog_engine: AsyncEngine
) -> None:
    await register_and_login(client)
    await seed_style(catalog_engine, style_no=STYLE)
    await seed_video(business_engine, video_id="901", style_no=STYLE, orders=90, views=1)
    await seed_video(business_engine, video_id="902", style_no=STYLE, orders=1, views=90)

    by_views = (await search(client, sort_by="views", limit=1)).json()

    assert by_views["videoUrls"] == urls_of(["902"])


async def test_a_video_shared_by_two_styles_appears_once(
    client: httpx.AsyncClient, business_engine: AsyncEngine, catalog_engine: AsyncEngine
) -> None:
    """两个入参款都落到同一批替身上时，同一条视频只出现一次。"""

    await register_and_login(client)
    for style_no in (STYLE, "SNMT242M"):
        await seed_style(catalog_engine, style_no=style_no, category_id=RUNNING, brand_code=NORTIV8)
    await seed_video(
        business_engine,
        video_id="1001",
        style_no="OTHER-NORTIV8",
        category_id=RUNNING,
        brand_code=NORTIV8,
    )

    found = (await client.post(URL, json={"styleNos": [STYLE, "SNMT242M"]})).json()

    assert found["videoUrls"] == urls_of(["1001"])
    assert found["matches"] == [
        {"styleNo": STYLE, "matchLevel": "sameBrandCategory"},
        {"styleNo": "SNMT242M", "matchLevel": "sameBrandCategory"},
    ]


async def test_sort_key_is_a_closed_enum(client: httpx.AsyncClient) -> None:
    await register_and_login(client)

    assert (await search(client, sort_by="video_revenue_amt")).status_code == 422


async def test_request_shape_is_bounded(client: httpx.AsyncClient) -> None:
    await register_and_login(client)

    assert (await client.post(URL, json={"styleNos": []})).status_code == 422
    assert (
        await client.post(URL, json={"styleNos": [f"S{index}" for index in range(21)]})
    ).status_code == 422
    assert (await search(client, limit=101)).status_code == 422
    assert (await search(client, filters={"minOrders": -1})).status_code == 422


async def test_without_the_product_catalog_returns_exact_but_cannot_fall_back(
    app_without_catalog: FastAPI,
    business_engine: AsyncEngine,
) -> None:
    """缺产品资料库时仍返回本款视频，未精确命中的款不能按归属找替身。"""

    await seed_video(business_engine, video_id="1201", style_no=STYLE)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_without_catalog), base_url="http://test"
    ) as client:
        await register_and_login(client)

        found = await client.post(URL, json={"styleNos": [STYLE, "UNKNOWN"]})

        assert found.status_code == 200
        assert found.json() == {
            "videoUrls": urls_of(["1201"]),
            "matches": [
                {"styleNo": STYLE, "matchLevel": "exact"},
                {"styleNo": "UNKNOWN", "matchLevel": "none"},
            ],
        }


@pytest.mark.parametrize("sort_by", ["impressions", "views", "clicks", "orders", "revenue"])
async def test_every_sort_key_is_accepted(
    client: httpx.AsyncClient,
    business_engine: AsyncEngine,
    catalog_engine: AsyncEngine,
    sort_by: str,
) -> None:
    await register_and_login(client)
    await seed_style(catalog_engine, style_no=STYLE)
    await seed_video(business_engine, video_id="1101", style_no=STYLE)

    found = await search(client, sort_by=sort_by)

    assert found.status_code == 200
    assert found.json()["videoUrls"] == urls_of(["1101"])
