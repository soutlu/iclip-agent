"""爆款视频查询的测试装置。

视频快照表由迁移建出并灌入真实快照，用例先清空再插入受控数据；降级要按品类与
品牌圈选同类款，所以还需要产品资料替身表。"""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncGenerator, Sequence
from decimal import Decimal

import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.app.bootstrap import build_app
from tests.helpers.pdm import PDM_STYLES_DDL
from tests.helpers.pg import IDENTITY_TABLES, truncate_clean
from tests.integration_no_llm.conftest import make_runtime_config

_CATALOG_DDL = f"""
DROP TABLE IF EXISTS pdm_styles CASCADE;
{PDM_STYLES_DDL}
"""

_INSERT_STYLE = text(
    "INSERT INTO pdm_styles"
    " (pdm_entity_id, product_number, style_wms, source_status,"
    "  product_category_id, attributes)"
    " VALUES (:entity_id, :style_no, :style_no, 'effective', :category_id,"
    "         cast(:attributes as json))"
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


@pytest.fixture
async def catalog_engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    """与业务库共用测试容器的产品资料替身表。"""

    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            for statement in filter(None, (part.strip() for part in _CATALOG_DDL.split(";"))):
                await conn.execute(text(statement))
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
async def business_engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    """业务库连接；清掉迁移灌入的真实快照，让用例只面对自己插的数据。"""

    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            await truncate_clean(conn, IDENTITY_TABLES, cascade=True)
            await conn.execute(text("TRUNCATE TABLE iclip.inspiration_videos"))
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
async def app(
    monkeypatch: pytest.MonkeyPatch,
    base_env: None,
    migrated_pg: str,
    business_engine: AsyncEngine,
    catalog_engine: AsyncEngine,
) -> AsyncGenerator[FastAPI]:
    """启用爆款视频查询的 app。"""

    monkeypatch.setenv("PRODUCT_CATALOG_DATABASE_URL", migrated_pg)
    monkeypatch.setenv("PRODUCT_IMAGE_BASE_URL", "https://bucket.example.com/")
    yield build_app(
        make_runtime_config(),
        engine=business_engine,
        models={},
        product_catalog_engine=catalog_engine,
    )


@pytest.fixture
async def app_without_catalog(
    base_env: None, business_engine: AsyncEngine
) -> AsyncGenerator[FastAPI]:
    """未配置产品资料库的 app：接口照常挂载，但降级整级失效。"""

    yield build_app(make_runtime_config(), engine=business_engine, models={})


async def seed_style(
    engine: AsyncEngine,
    *,
    style_no: str,
    category_id: int | None = 70,
    brand_code: str | None = "3",
    entity_id: int | None = None,
) -> None:
    """登记一个款的品类与品牌归属。``None`` 表示上游缺这一项。"""

    attributes = "{}" if brand_code is None else f'{{"brand": "{brand_code}"}}'
    async with engine.begin() as conn:
        await conn.execute(
            _INSERT_STYLE,
            {
                "entity_id": entity_id if entity_id is not None else abs(hash(style_no)) % 10**9,
                "style_no": style_no,
                "category_id": category_id,
                "attributes": attributes,
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
