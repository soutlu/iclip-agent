"""爆款视频查询的夹具：在测试库里立起爆款库那两张表的替身。

**绝不连真的爆款库**：那是生产数据。这里按上游的 schema 与形状建同名表（只建查询
碰到的那几列），插进受控的行。
"""

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
    """爆款库的替身，跟业务库共用同一个测试容器、但用的是自己那个 schema。"""

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
    """装上爆款视频查询的 app（父层那个夹具默认不开这项能力）。"""

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
    """没配爆款库的 app：``base_env`` 已经把那个变量清掉了。"""

    engine = create_async_engine(migrated_pg)
    try:
        yield build_app(make_runtime_config(), engine=engine, models={})
    finally:
        await engine.dispose()
