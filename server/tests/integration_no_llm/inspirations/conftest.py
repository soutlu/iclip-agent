"""在测试库中创建爆款视频源的最小表结构与受控数据，不连接生产源。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.app.bootstrap import build_app
from tests.integration_no_llm.conftest import make_runtime_config

_DDL = """
CREATE SCHEMA IF NOT EXISTS video_labeling;

DROP TABLE IF EXISTS video_labeling.dws_ttk_shop_bi_video_popular_tag_stats_df,
                     video_labeling.videos CASCADE;

CREATE TABLE video_labeling.dws_ttk_shop_bi_video_popular_tag_stats_df (
    video_id           varchar PRIMARY KEY,
    popular_mon        varchar,
    posted_date        varchar,
    video_url          varchar NOT NULL,
    kol_name           varchar,
    style              varchar,
    ct                 varchar,
    product_category   varchar,
    total_impressions  integer NOT NULL DEFAULT 0,
    total_vv           integer NOT NULL DEFAULT 0,
    total_clicks       integer NOT NULL DEFAULT 0,
    total_orders       integer NOT NULL DEFAULT 0,
    video_revenue_amt  numeric NOT NULL DEFAULT 0,
    is_brand_popular   integer NOT NULL DEFAULT 0,
    is_kol_popular     integer NOT NULL DEFAULT 0,
    is_tt_popular      integer NOT NULL DEFAULT 0
);

CREATE TABLE video_labeling.videos (
    id             varchar PRIMARY KEY,
    oss_video_url  text
);
"""


@pytest.fixture
async def inspiration_engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    """与业务库共用测试容器，使用独立 schema 的爆款视频源替身。"""

    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            for statement in filter(None, (part.strip() for part in _DDL.split(";"))):
                await conn.execute(text(statement))
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
async def app(
    monkeypatch: pytest.MonkeyPatch,
    base_env: None,
    migrated_pg: str,
    inspiration_engine: AsyncEngine,
) -> AsyncGenerator[FastAPI]:
    """启用爆款视频查询的 app。"""

    monkeypatch.setenv("INSPIRATION_DATABASE_URL", migrated_pg)
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await conn.execute(
            text("TRUNCATE iclip.api_keys, iclip.oauth_accounts, iclip.users CASCADE")
        )
    try:
        yield build_app(
            make_runtime_config(),
            engine=engine,
            models={},
            inspirations_engine=inspiration_engine,
        )
    finally:
        await engine.dispose()


@pytest.fixture
async def app_without_inspirations(base_env: None, migrated_pg: str) -> AsyncGenerator[FastAPI]:
    """未配置爆款视频源的 app；base_env 已清除连接变量。"""

    engine = create_async_engine(migrated_pg)
    try:
        yield build_app(make_runtime_config(), engine=engine, models={})
    finally:
        await engine.dispose()
