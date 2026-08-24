"""组合根的装配前提：能力没配齐就别启动，没有 agent 就别挂 agent 路由。"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from pydantic_ai.models.test import TestModel
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import build_app
from iclip.config import (
    AppSection,
    DbSection,
    OpsSection,
    PmsSection,
    RedisSection,
    ResolvedAgent,
    RuntimeConfig,
    SecuritySection,
    SsoSection,
)
from tests.helpers.run_stream import MemoryRunStream

AGENT_ID = "storyboard"


def config_without_redis() -> RuntimeConfig:
    return RuntimeConfig(
        app=AppSection(name="t"),
        db=DbSection(url_env="T_DB_URL", schema="iclip"),
        security=SecuritySection(secret_env="T_SECRET"),
        sso=SsoSection(base_url_env="T_SSO", app_name="iclip", redirect_url_env="T_SSO_REDIRECT"),
        pms=PmsSection(base_url_env="T_PMS"),
        ops=OpsSection(log_level="WARNING"),
    )


def declared_agent(tmp_path: Path) -> ResolvedAgent:
    spec_dir = tmp_path / AGENT_ID
    spec_dir.mkdir(parents=True, exist_ok=True)
    spec = spec_dir / "agent.yaml"
    spec.write_text("", encoding="utf-8")
    return ResolvedAgent(
        agent_id=AGENT_ID,
        spec=spec,
        instructions=None,
        model="m",
        skills=None,
        packs=(),
        subagents=(),
    )


@pytest.fixture
def base_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("T_DB_URL", "postgresql+asyncpg://iclip:iclip@localhost:5432/nowhere")
    monkeypatch.setenv("T_SECRET", "s" * 32)
    monkeypatch.delenv("T_SSO", raising=False)
    monkeypatch.delenv("T_REDIS_URL", raising=False)


def engine():
    """只构造，不连接——本文件验的是装配期的判断。"""

    return create_async_engine("postgresql+asyncpg://iclip:iclip@localhost:5432/nowhere")


def test_declared_agents_without_redis_fail_at_startup(base_env: None, tmp_path: Path) -> None:
    """事件流是 agent 运行的必需件，缺了就别启动——不许退化成「跑但断了就丢」。"""

    with pytest.raises(RuntimeError, match="redis"):
        build_app(
            config_without_redis(),
            agents=(declared_agent(tmp_path),),
            engine=engine(),
            models={"m": TestModel()},
        )


def test_declared_agents_with_redis_section_build(
    base_env: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("T_REDIS_URL", "redis://localhost:6379/0")
    config = config_without_redis().model_copy(
        update={"redis": RedisSection(url_env="T_REDIS_URL")}
    )

    app = build_app(
        config,
        agents=(declared_agent(tmp_path),),
        engine=engine(),
        models={"m": TestModel()},
    )

    assert app.title == "t"


async def test_without_agents_the_run_endpoints_are_absent(base_env: None) -> None:
    """没声明 agent 就不挂这组路由，也就不需要 Redis（同 SSO 关闭时的做法）。"""

    app = build_app(config_without_redis(), engine=engine(), models={})
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(f"/agents/{AGENT_ID}/chat", json={})

    assert response.status_code == 404


async def test_injected_stream_needs_no_redis_config(base_env: None, tmp_path: Path) -> None:
    """测试可以自带事件流；那时不读 redis 段。"""

    app = build_app(
        config_without_redis(),
        agents=(declared_agent(tmp_path),),
        engine=engine(),
        models={"m": TestModel()},
        run_stream=MemoryRunStream(),
    )

    assert app.title == "t"
