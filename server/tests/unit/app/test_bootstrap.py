"""组合根的装配前提：能力没配齐就别启动，没有 agent 就别挂 agent 路由。"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Literal

import httpx
import pytest
from pydantic import ValidationError
from pydantic_ai.models.test import TestModel
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import AnnouncingFileStore, build_app
from iclip.config import (
    AppSection,
    DbSection,
    ImageGenerationSection,
    MediaGenerationSection,
    OpsSection,
    ResolvedAgent,
    RuntimeConfig,
    SecuritySection,
    SsoSection,
    VideoGenerationSection,
)
from iclip.domains.agents.transcript_api import LiveConnections
from tests.helpers.file_store import FakeFileStore
from tests.helpers.generation import MemoryObjectStore

AGENT_ID = "storyboard"


def minimal_config() -> RuntimeConfig:
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


def test_declared_agents_build(base_env: None, tmp_path: Path) -> None:
    """声明了 agent 就能装起来，不再需要任何外部队列。"""

    app = build_app(
        minimal_config(),
        agents=(declared_agent(tmp_path),),
        engine=engine(),
        models={"m": TestModel()},
    )

    assert app.title == "t"


async def test_transcript_endpoints_are_always_mounted(base_env: None) -> None:
    """transcript 那组路由不看有没有声明 agent：没登录就该是 401，不是 404。"""

    app = build_app(minimal_config(), engine=engine(), models={})
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/conversations/00000000-0000-0000-0000-000000000000/prompts",
            json={"prompt_id": "prm_1", "content": [{"type": "text", "text": "走"}]},
        )

    assert response.status_code == 401


MEDIA_ENVS = {
    "VIDEO_SUBMIT_URL": "https://video.test/generate",
    "VIDEO_STATUS_BASE_URL": "https://video.test/tasks",
    "VIDEO_API_KEY": "vk",
    "IMAGE_TEXT_TO_IMAGE_URL": "https://image.test/text-to-image",
    "IMAGE_EDIT_URL": "https://image.test/image-edit",
}


def config_with_media() -> RuntimeConfig:
    return minimal_config().model_copy(
        update={
            "media_generation": MediaGenerationSection(
                video=VideoGenerationSection(model="seedance", user_name="iclip-agent"),
                image=ImageGenerationSection(user_name="iclip-agent"),
            ),
        }
    )


async def test_without_media_generation_the_routes_are_absent(base_env: None) -> None:
    """没开生成就不挂这组路由（同 SSO 关闭时的做法）。"""

    app = build_app(minimal_config(), engine=engine(), models={})
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


class _RecordingConnections(LiveConnections):
    """只记下发过哪些「文件变了」的帧，不真的连 WS。"""

    def __init__(self) -> None:
        super().__init__()
        self.announced: list[tuple[uuid.UUID, uuid.UUID, str, str]] = []

    def announce_fs_changed(
        self,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        path: str,
        change: Literal["created", "modified", "deleted"] = "modified",
    ) -> None:
        self.announced.append((owner, conversation_id, path, change))


async def test_tool_writes_announce_created_then_modified_then_deleted() -> None:
    """工具那条路写文件也发帧：第一版是 created，之后是 modified，删了是 deleted。

    能力包写文件只经 ``FileStore`` 协议，包在组合根这一层两边都不用改接口。
    """

    live = _RecordingConnections()
    owner, conversation_id = uuid.uuid4(), uuid.uuid4()
    store = AnnouncingFileStore(FakeFileStore(), live)

    await store.write(f"{owner}/{conversation_id}", "video_shot.json", "{}")
    await store.write(f"{owner}/{conversation_id}", "video_shot.json", "{ }")
    await store.delete(f"{owner}/{conversation_id}", "video_shot.json")

    assert live.announced == [
        (owner, conversation_id, "video_shot.json", "created"),
        (owner, conversation_id, "video_shot.json", "modified"),
        (owner, conversation_id, "video_shot.json", "deleted"),
    ]


async def test_a_namespace_without_a_conversation_id_announces_nothing() -> None:
    """地盘不是按对话分的就没法按对话推送。少一帧只是界面晚点对齐，不该让写入失败。"""

    live = _RecordingConnections()
    store = AnnouncingFileStore(FakeFileStore(), live)

    written = await store.write("luke/thread-1", "提纲.md", "三幕")

    assert written.version == 1, "文件照样写下去了"
    assert live.announced == []
