"""在测试库中创建外部产品目录的最小表结构与受控数据，不连接生产目录库。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.app.bootstrap import build_app
from tests.integration_no_llm.conftest import make_runtime_config

IMAGE_BASE_URL = "https://bucket.example.com/"
"""末尾斜杠用于验证 URL 拼接不会产生双斜杠。"""

_DDL = """
DROP TABLE IF EXISTS pdm_asset_versions, assets, pdm_file_mappings,
                     pdm_skcs, pdm_colors, pdm_styles CASCADE;

CREATE TABLE pdm_styles (
    pdm_entity_id      bigint PRIMARY KEY,
    product_number     varchar NOT NULL,
    style_wms          varchar,
    source_status      varchar NOT NULL,
    product_category_id bigint,
    attributes         json    NOT NULL DEFAULT '{}'::json,
    is_active          boolean NOT NULL DEFAULT true,
    is_source_deleted  boolean NOT NULL DEFAULT false
);

CREATE TABLE pdm_file_mappings (
    id                uuid PRIMARY KEY,
    pdm_entity_id     bigint  NOT NULL,
    business_id       bigint  NOT NULL,
    file_type         integer NOT NULL,
    is_active         boolean NOT NULL DEFAULT true,
    is_source_deleted boolean NOT NULL DEFAULT false
);

CREATE TABLE assets (
    id           uuid PRIMARY KEY,
    object_key   varchar NOT NULL,
    content_hash varchar NOT NULL,
    width        integer,
    height       integer
);

CREATE TABLE pdm_asset_versions (
    id                  uuid PRIMARY KEY,
    pdm_file_mapping_id uuid    NOT NULL,
    asset_id            uuid    NOT NULL,
    is_current          boolean NOT NULL DEFAULT true,
    status              varchar NOT NULL DEFAULT 'succeeded'
);

CREATE TABLE pdm_skcs (
    pdm_entity_id     bigint PRIMARY KEY,
    style_pdm_id      bigint  NOT NULL,
    color_pdm_id      bigint,
    is_active         boolean NOT NULL DEFAULT true,
    is_source_deleted boolean NOT NULL DEFAULT false
);

CREATE TABLE pdm_colors (
    pdm_entity_id     bigint PRIMARY KEY,
    color_code        varchar NOT NULL,
    display_name      varchar NOT NULL,
    rgb               varchar,
    attributes        json    NOT NULL DEFAULT '{}'::json,
    is_active         boolean NOT NULL DEFAULT true,
    is_source_deleted boolean NOT NULL DEFAULT false
);
"""


@pytest.fixture
async def catalog_engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    """与业务库共用测试容器的产品目录替身表。"""

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
    catalog_engine: AsyncEngine,
) -> AsyncGenerator[FastAPI]:
    """启用产品资料查询的 app。"""

    monkeypatch.setenv("PRODUCT_CATALOG_DATABASE_URL", migrated_pg)
    monkeypatch.setenv("PRODUCT_IMAGE_BASE_URL", IMAGE_BASE_URL)
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
            product_catalog_engine=catalog_engine,
        )
    finally:
        await engine.dispose()


@pytest.fixture
async def app_without_catalog(base_env: None, migrated_pg: str) -> AsyncGenerator[FastAPI]:
    """未配置产品目录的 app；base_env 已清除相关变量。"""

    engine = create_async_engine(migrated_pg)
    try:
        yield build_app(make_runtime_config(), engine=engine, models={})
    finally:
        await engine.dispose()
