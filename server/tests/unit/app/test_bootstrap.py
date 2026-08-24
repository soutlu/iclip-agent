"""组合根的装配前提：能力没配齐就别启动，没有 agent 就别挂 agent 路由。"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError
from pydantic_ai.models.test import TestModel
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import build_app
from iclip.config import (
    AppSection,
    DbSection,
    ImageGenerationSection,
    MediaGenerationSection,
    OpsSection,
    RedisSection,
    ResolvedAgent,
    RuntimeConfig,
    SecuritySection,
    SsoSection,
    VideoGenerationSection,
)
from tests.helpers.generation import MemoryObjectStore
from tests.helpers.run_stream import MemoryRunStream

AGENT_ID = "storyboard"


def config_without_redis() -> RuntimeConfig:
    return RuntimeConfig(
        app=AppSection(name="t"),
        db=DbSection(schema="iclip"),
        security=SecuritySection(),
        sso=SsoSection(app_name="iclip"),
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
        capabilities=(),
        subagents=(),
    )


@pytest.fixture
def base_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://iclip:iclip@localhost:5432/nowhere")
    monkeypatch.setenv("AUTH_SECRET", "s" * 32)
    monkeypatch.delenv("SSO_BASE_URL", raising=False)
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.setenv("OSS_BUCKET", "iclip")
    monkeypatch.setenv("OSS_ENDPOINT", "https://oss.test")
    monkeypatch.setenv("OSS_ACCESS_KEY_ID", "ak")
    monkeypatch.setenv("OSS_ACCESS_KEY_SECRET", "sk")
    monkeypatch.setenv("OSS_PUBLIC_URL_BASE", "https://cdn.test")
    # 默认把媒体生成关掉：开关就是 VIDEO_SUBMIT_URL 有没有值。
    for name in MEDIA_ENVS:
        monkeypatch.delenv(name, raising=False)


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
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    config = config_without_redis().model_copy(update={"redis": RedisSection()})

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


MEDIA_ENVS = {
    "VIDEO_SUBMIT_URL": "https://video.test/generate",
    "VIDEO_STATUS_BASE_URL": "https://video.test/tasks",
    "VIDEO_API_KEY": "vk",
    "IMAGE_TEXT_TO_IMAGE_URL": "https://image.test/text-to-image",
    "IMAGE_EDIT_URL": "https://image.test/image-edit",
}


def config_with_media() -> RuntimeConfig:
    return config_without_redis().model_copy(
        update={
            "media_generation": MediaGenerationSection(
                video=VideoGenerationSection(model="seedance", user_name="iclip-agent"),
                image=ImageGenerationSection(user_name="iclip-agent"),
            ),
        }
    )


async def test_without_media_generation_the_routes_are_absent(base_env: None) -> None:
    """没开生成就不挂这组路由（同 SSO 关闭时的做法）。"""

    app = build_app(config_without_redis(), engine=engine(), models={})
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.post("/generations", json={})).status_code == 404


async def test_media_generation_mounts_routes_when_configured(
    base_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """开了就挂上；未认证是 401 而不是 404——路由确实在。

    对象存储注入替身：装 OSS 客户端要真的凭证，而这里验的是装配期的判断。
    """

    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)

    app = build_app(
        config_with_media(),
        engine=engine(),
        models={},
        object_store=MemoryObjectStore(),
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get("/generations")).status_code == 401


def test_media_generation_half_configured_fails_at_startup(
    base_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """半开着比关着更糟：路由挂上了，点下去才发现某个地址没配。"""

    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("IMAGE_EDIT_URL")

    # pydantic 会把缺的那几个一次全报出来，报的是变量名本身。
    with pytest.raises(ValidationError, match="IMAGE_EDIT_URL"):
        build_app(config_with_media(), engine=engine(), models={})
