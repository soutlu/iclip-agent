"""爆款视频查询的测试装置。

视频快照表由迁移建出并灌入真实快照，用例先清空再插入受控数据；降级要按品类与
品牌圈选同类款，所以还需要产品资料替身表。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.app.bootstrap import build_app
from tests.helpers.app import make_runtime_config
from tests.helpers.pdm import recreate_pdm_styles
from tests.helpers.pg import reset_database


@pytest.fixture
async def catalog_engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    """与业务库共用测试容器的产品资料替身表。"""

    engine = create_async_engine(migrated_pg)
    try:
        await recreate_pdm_styles(engine)
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
async def business_engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    """业务库连接；清掉迁移灌入的真实快照，让用例只面对自己插的数据。"""

    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            await reset_database(conn)
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
