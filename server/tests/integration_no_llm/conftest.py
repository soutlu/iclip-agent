"""integration_no_llm 夹具：真实 Postgres 三级解析 + 迁移 + app 装配。

Postgres 解析顺序：显式 ``ICLIP_TEST_DATABASE_URL`` > testcontainers 本地兜底
> 不可用即 skip（CI 必须提供 service container，因此 CI 永不静默 skip）。
"""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator, Generator
from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import build_app
from iclip.config import (
    AppSection,
    DbSection,
    OpsSection,
    PmsSection,
    RuntimeConfig,
    SecuritySection,
    SsoSection,
)
from iclip.domains.identity.pms import PmsUserClient
from iclip.domains.identity.sso import SsoVerifier

SERVER_DIR = Path(__file__).resolve().parents[2]

TEST_SECRET = "test-secret-0123456789-0123456789-xyz"


@pytest.fixture(scope="session")
def pg_url() -> Generator[str]:
    explicit = os.environ.get("ICLIP_TEST_DATABASE_URL", "").strip()
    if explicit:
        yield explicit
        return
    try:
        from testcontainers.postgres import PostgresContainer
    except ImportError:
        pytest.skip("无 ICLIP_TEST_DATABASE_URL 且未安装 testcontainers")
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


def make_runtime_config() -> RuntimeConfig:
    return RuntimeConfig(
        app=AppSection(name="iclip-test"),
        db=DbSection(url_env="ICLIP_DATABASE_URL", schema="iclip"),
        security=SecuritySection(secret_env="ICLIP_AUTH_SECRET"),
        sso=SsoSection(
            base_url_env="WANGOON_SSO_BASE_URL",
            app_name="iclip",
            redirect_url_env="ICLIP_SSO_REDIRECT_URL",
        ),
        pms=PmsSection(base_url_env="WANGOON_PMS_BASE_URL"),
        ops=OpsSection(log_level="WARNING"),
    )


@pytest.fixture
def base_env(monkeypatch: pytest.MonkeyPatch, migrated_pg: str) -> None:
    monkeypatch.setenv("ICLIP_DATABASE_URL", migrated_pg)
    monkeypatch.setenv("ICLIP_AUTH_SECRET", TEST_SECRET)
    monkeypatch.delenv("WANGOON_SSO_BASE_URL", raising=False)
    monkeypatch.delenv("WANGOON_PMS_BASE_URL", raising=False)
    monkeypatch.delenv("ICLIP_SSO_REDIRECT_URL", raising=False)


async def _fresh_engine(url: str):
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.execute(
            text("TRUNCATE iclip.api_keys, iclip.oauth_accounts, iclip.users CASCADE")
        )
    return engine


@pytest.fixture
async def app(base_env: None, migrated_pg: str) -> AsyncGenerator[FastAPI]:
    engine = await _fresh_engine(migrated_pg)
    try:
        yield build_app(make_runtime_config(), engine=engine)
    finally:
        await engine.dispose()


@pytest.fixture
def ws_app(base_env: None, migrated_pg: str) -> Generator[FastAPI]:
    """WS 场景专用：app 全程活在 TestClient 的事件循环里。

    NullPool 让每个连接在当前 loop 新建，避免连接池跨 loop 复用
    （asyncpg 连接绑定创建时的事件循环）。
    """

    import asyncio

    from sqlalchemy.pool import NullPool

    async def _truncate() -> None:
        engine = create_async_engine(migrated_pg, poolclass=NullPool)
        try:
            async with engine.begin() as conn:
                await conn.execute(
                    text("TRUNCATE iclip.api_keys, iclip.oauth_accounts, iclip.users CASCADE")
                )
        finally:
            await engine.dispose()

    asyncio.run(_truncate())
    engine = create_async_engine(migrated_pg, poolclass=NullPool)
    yield build_app(make_runtime_config(), engine=engine)
    asyncio.run(engine.dispose())


@pytest.fixture
async def sso_app(
    monkeypatch: pytest.MonkeyPatch,
    base_env: None,
    migrated_pg: str,
    sso_transport: httpx.MockTransport,
    pms_transport: httpx.MockTransport | None,
) -> AsyncGenerator[FastAPI]:
    """SSO 开启的 app；协议外呼经 MockTransport。"""

    monkeypatch.setenv("WANGOON_SSO_BASE_URL", "https://sso.test")
    monkeypatch.setenv("ICLIP_SSO_REDIRECT_URL", "https://app.test/auth/sso/landing")
    if pms_transport is not None:
        monkeypatch.setenv("WANGOON_PMS_BASE_URL", "https://pms.test")

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
    engine = await _fresh_engine(migrated_pg)
    try:
        yield build_app(make_runtime_config(), engine=engine, sso_verifier=verifier, pms_client=pms)
    finally:
        await engine.dispose()


def make_client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.fixture
async def client(app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(app) as c:
        yield c


async def register_and_login(
    client: httpx.AsyncClient,
    *,
    username: str = "luke",
    email: str = "luke@example.com",
    password: str = "password-123",
) -> str:
    """注册 + 登录；返回用户 id。"""

    created = await client.post(
        "/auth/register",
        json={"email": email, "password": password, "username": username},
    )
    assert created.status_code == 201, created.text
    logged_in = await client.post("/auth/login", data={"username": username, "password": password})
    assert logged_in.status_code == 204, logged_in.text
    return str(created.json()["id"])


async def set_role_in_db(pg_url: str, email: str, role: str) -> None:
    """测试内的角色引导（生产路径是 scripts/admin.py）。"""

    engine = create_async_engine(pg_url)
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text("UPDATE iclip.users SET role = :role WHERE email = :email"),
                {"role": role, "email": email},
            )
    finally:
        await engine.dispose()
