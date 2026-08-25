"""integration_no_llm 夹具：真实 Postgres 三级解析 + 迁移 + app 装配。

Postgres 解析顺序：显式 ``TEST_DATABASE_URL`` > testcontainers 本地兜底
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
from pydantic_ai.models.test import TestModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import build_app
from iclip.config import (
    AppSection,
    DbSection,
    OpsSection,
    RedisSection,
    ResolvedAgent,
    RuntimeConfig,
    SecuritySection,
    SsoSection,
)
from iclip.domains.identity.pms import PmsUserClient
from iclip.domains.identity.sso import SsoVerifier
from tests.helpers.tasks import StubStyleSnapshots

SERVER_DIR = Path(__file__).resolve().parents[2]

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
            from testcontainers.postgres import PostgresContainer  # 旧命名空间兜底
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
def redis_url() -> Generator[str]:
    """真实 Redis，解析顺序同 Postgres：显式 env > 一次性容器 > 不可用即 skip。

    只有声明了 agent 的测试才会用到它（见 ``stream_url``），别的测试不会因此
    多起一个容器。
    """

    explicit = os.environ.get("TEST_REDIS_URL", "").strip()
    if explicit:
        yield explicit
        return
    try:
        from testcontainers.community.redis import RedisContainer
    except ImportError:
        pytest.skip("无 TEST_REDIS_URL 且未安装 testcontainers 的 redis 模块")
    try:
        container = RedisContainer("redis:7")
        container.start()
    except Exception as exc:
        pytest.skip(f"本地无可用 Docker/Redis: {exc}")
    try:
        host = container.get_container_host_ip()
        yield f"redis://{host}:{container.get_exposed_port(6379)}/0"
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


def make_runtime_config(*, with_redis: bool = False) -> RuntimeConfig:
    """测试用的 YAML 形状。地址与凭证不在这里——它们由 env 提供（见 ``base_env``）。"""

    return RuntimeConfig(
        app=AppSection(name="iclip-test"),
        db=DbSection(schema="iclip"),
        security=SecuritySection(),
        sso=SsoSection(app_name="iclip"),
        redis=RedisSection() if with_redis else None,
        ops=OpsSection(log_level="WARNING"),
    )


@pytest.fixture
def base_env(monkeypatch: pytest.MonkeyPatch, migrated_pg: str) -> None:
    monkeypatch.setenv("DATABASE_URL", migrated_pg)
    monkeypatch.setenv("AUTH_SECRET", TEST_SECRET)
    monkeypatch.delenv("SSO_BASE_URL", raising=False)
    monkeypatch.delenv("PMS_BASE_URL", raising=False)
    monkeypatch.delenv("SSO_REDIRECT_URL", raising=False)
    monkeypatch.delenv("ROOT_EMAIL", raising=False)
    # 开发机上真配了产品目录库的话，别让它悄悄混进每个测试的 app。
    monkeypatch.delenv("PRODUCT_CATALOG_DATABASE_URL", raising=False)
    monkeypatch.delenv("PRODUCT_IMAGE_BASE_URL", raising=False)
    monkeypatch.delenv("INSPIRATION_DATABASE_URL", raising=False)
    # 同理，别让开发机上那把真桶凭证混进来——测试要么注入替身桶，要么就没有桶。
    monkeypatch.delenv("OSS_BUCKET", raising=False)


async def _fresh_engine(url: str):
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.execute(
            text("TRUNCATE iclip.api_keys, iclip.oauth_accounts, iclip.users CASCADE")
        )
    return engine


TEST_MODEL_NAME = "test-model"


@pytest.fixture
def agent_declarations() -> tuple[ResolvedAgent, ...]:
    """测试可覆写：非空即注册对应 agent（默认无 agent，/agents/* 全部 404）。"""

    return ()


@pytest.fixture
def models() -> dict[str, TestModel]:
    """官方 test 替身；agent 声明引用 TEST_MODEL_NAME。"""

    return {TEST_MODEL_NAME: TestModel()}


@pytest.fixture
def stream_url(
    request: pytest.FixtureRequest, agent_declarations: tuple[ResolvedAgent, ...]
) -> str | None:
    """声明了 agent 才去要 Redis：没有 agent 的测试不该为此起容器。"""

    if not agent_declarations:
        return None
    return str(request.getfixturevalue("redis_url"))


@pytest.fixture
async def app(
    monkeypatch: pytest.MonkeyPatch,
    base_env: None,
    migrated_pg: str,
    agent_declarations: tuple[ResolvedAgent, ...],
    models: dict[str, TestModel],
    stream_url: str | None,
) -> AsyncGenerator[FastAPI]:
    if stream_url is not None:
        monkeypatch.setenv("REDIS_URL", stream_url)
    engine = await _fresh_engine(migrated_pg)
    try:
        yield build_app(
            make_runtime_config(with_redis=stream_url is not None),
            agents=agent_declarations,
            engine=engine,
            models=models,
            # 款号快照的内容来自 PDM 与对象存储，这一层不连它们；替身给一份固定快照，
            # 让「快照存进库读回来还是同一份」这件事仍然在真库上被验到。
            style_snapshots=StubStyleSnapshots(),
        )
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


async def set_roles_in_db(pg_url: str, email: str, roles: list[str]) -> None:
    """测试内的角色引导（生产路径是 ROOT_EMAIL / scripts/admin.py）。"""

    import json

    engine = create_async_engine(pg_url)
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text("UPDATE iclip.users SET roles = CAST(:roles AS jsonb) WHERE email = :email"),
                {"roles": json.dumps(roles), "email": email},
            )
    finally:
        await engine.dispose()


async def new_conversation(client: httpx.AsyncClient, agent_id: str) -> str:
    """开一段对话，返回它的 id（AG-UI 请求体里的 ``threadId`` 用的就是它）。

    agent 端点只认服务端自己发出去的会话 id，所以凡是要真跑一次运行的用例都得
    先走这一步。
    """

    created = await client.post("/conversations", json={"agentId": agent_id})
    assert created.status_code == 201, created.text
    return str(created.json()["conversation"]["id"])
