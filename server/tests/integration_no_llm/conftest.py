"""integration_no_llm 夹具：真实 Postgres 三级解析 + 迁移 + app 装配。

Postgres 解析顺序：显式 ``TEST_DATABASE_URL`` > testcontainers 本地兜底
> 不可用即 skip（CI 必须提供 service container，因此 CI 永不静默 skip）。
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncGenerator, Generator
from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from pydantic_ai import models as pydantic_ai_models
from pydantic_ai.models.test import TestModel
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from iclip.app.bootstrap import build_app
from iclip.config import ResolvedAgent
from iclip.domains.identity.pms import PmsUserClient
from iclip.domains.identity.sso import SsoVerifier
from tests.helpers.app import TEST_MODEL_NAME, make_client, make_runtime_config
from tests.helpers.pg import connected, reset_database

SERVER_DIR = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _no_real_model_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    """官方护栏：这一层只用替身，任何真模型请求都直接报错。按用例开关，不影响同一进程里的其他层。"""

    monkeypatch.setattr(pydantic_ai_models, "ALLOW_MODEL_REQUESTS", False)


TEST_SECRET = "test-secret-0123456789-0123456789-xyz"


@pytest.fixture(scope="session")
def pg_url() -> Generator[str]:
    explicit = os.environ.get("TEST_DATABASE_URL", "").strip()
    if explicit:
        yield explicit
        return
    try:
        from testcontainers.community.postgres import PostgresContainer
    except ImportError:
        try:
            from testcontainers.postgres import (
                PostgresContainer,
            )  # 兼容 testcontainers 的旧导入路径。
        except ImportError:
            pytest.skip("无 TEST_DATABASE_URL 且未安装 testcontainers")
    try:
        container = PostgresContainer("postgres:16", driver="asyncpg")
        container.start()
    except Exception as exc:
        pytest.skip(f"本地无可用 Docker/Postgres: {exc}")
    try:
        yield container.get_connection_url()
    finally:
        container.stop()


@pytest.fixture(scope="session")
def migrated_pg(pg_url: str) -> str:
    """对测试库执行 alembic upgrade head（每会话一次）。"""

    cfg = AlembicConfig(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    cfg.attributes["sqlalchemy_url"] = pg_url
    command.upgrade(cfg, "head")
    return pg_url


@pytest.fixture
def base_env(monkeypatch: pytest.MonkeyPatch, migrated_pg: str) -> None:
    monkeypatch.setenv("DATABASE_URL", migrated_pg)
    monkeypatch.setenv("AUTH_SECRET", TEST_SECRET)
    monkeypatch.delenv("SSO_BASE_URL", raising=False)
    monkeypatch.delenv("PMS_BASE_URL", raising=False)
    monkeypatch.delenv("SSO_REDIRECT_URL", raising=False)
    monkeypatch.delenv("ROOT_EMAIL", raising=False)
    # 隔离开发机的产品目录库配置。
    monkeypatch.delenv("PRODUCT_CATALOG_DATABASE_URL", raising=False)
    # 隔离开发机的对象存储凭证。
    monkeypatch.delenv("OSS_BUCKET", raising=False)


async def _reset(url: str) -> None:
    async with connected(url) as conn:
        await reset_database(conn)


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    """清空测试表后给出引擎；runner 与 transcript 场景测试直接用它装配。"""

    await _reset(migrated_pg)
    engine = create_async_engine(migrated_pg)
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
def agent_declarations() -> tuple[ResolvedAgent, ...]:
    """测试可覆写：非空即注册对应 agent（默认无 agent，/agents/* 全部 404）。"""

    return ()


@pytest.fixture
def models() -> dict[str, TestModel]:
    """官方 test 替身；agent 声明引用 TEST_MODEL_NAME。"""

    return {TEST_MODEL_NAME: TestModel()}


@pytest.fixture
async def app(
    base_env: None,
    migrated_pg: str,
    agent_declarations: tuple[ResolvedAgent, ...],
    models: dict[str, TestModel],
) -> AsyncGenerator[FastAPI]:
    await _reset(migrated_pg)
    engine = create_async_engine(migrated_pg)
    try:
        yield build_app(
            make_runtime_config(), agents=agent_declarations, engine=engine, models=models
        )
    finally:
        await engine.dispose()


@pytest.fixture
def ws_agent_app(
    base_env: None,
    migrated_pg: str,
    agent_declarations: tuple[ResolvedAgent, ...],
    models: dict[str, TestModel],
) -> Generator[FastAPI]:
    """在 TestClient 事件循环中装配带 agent 的 WS app。

    使用 NullPool 避免 asyncpg 连接跨事件循环复用。
    """

    asyncio.run(_reset(migrated_pg))
    engine = create_async_engine(migrated_pg, poolclass=NullPool)
    yield build_app(
        make_runtime_config(),
        agents=agent_declarations,
        engine=engine,
        models=models,
    )
    asyncio.run(engine.dispose())


@pytest.fixture
def ws_app(base_env: None, migrated_pg: str) -> Generator[FastAPI]:
    """在 TestClient 事件循环中装配 WS app。

    使用 NullPool 避免 asyncpg 连接跨事件循环复用。
    """

    asyncio.run(_reset(migrated_pg))
    engine = create_async_engine(migrated_pg, poolclass=NullPool)
    yield build_app(make_runtime_config(), engine=engine)
    asyncio.run(engine.dispose())


@pytest.fixture
def root_email() -> str | None:
    """测试可覆写：非空即启用 root 引导（ROOT_EMAIL）。"""

    return None


@pytest.fixture
async def sso_app(
    monkeypatch: pytest.MonkeyPatch,
    base_env: None,
    migrated_pg: str,
    sso_transport: httpx.MockTransport,
    pms_transport: httpx.MockTransport | None,
    root_email: str | None,
) -> AsyncGenerator[FastAPI]:
    """SSO 开启的 app；协议外呼经 MockTransport。"""

    monkeypatch.setenv("SSO_BASE_URL", "https://sso.test")
    monkeypatch.setenv("SSO_REDIRECT_URL", "https://app.test/auth/sso/landing")
    if root_email:
        monkeypatch.setenv("ROOT_EMAIL", root_email)
    if pms_transport is not None:
        monkeypatch.setenv("PMS_BASE_URL", "https://pms.test")

    verifier = SsoVerifier(
        base_url="https://sso.test",
        app_name="iclip",
        redirect_url="https://app.test/auth/sso/landing",
        transport=sso_transport,
    )
    pms = (
        PmsUserClient(base_url="https://pms.test", transport=pms_transport)
        if pms_transport is not None
        else None
    )
    await _reset(migrated_pg)
    engine = create_async_engine(migrated_pg)
    try:
        yield build_app(make_runtime_config(), engine=engine, sso_verifier=verifier, pms_client=pms)
    finally:
        await engine.dispose()


@pytest.fixture
async def client(app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(app) as c:
        yield c
