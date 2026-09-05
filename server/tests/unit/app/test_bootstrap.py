"""验证组合根的依赖完整性和路由挂载条件。"""

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
    for name in MEDIA_ENVS:
        monkeypatch.delenv(name, raising=False)


def engine():
    """仅构造 engine，不连接数据库；测试只覆盖装配。"""

    return create_async_engine("postgresql+asyncpg://iclip:iclip@localhost:5432/nowhere")


def test_declared_agents_build(base_env: None, tmp_path: Path) -> None:

    app = build_app(
        minimal_config(),
        agents=(declared_agent(tmp_path),),
        engine=engine(),
        models={"m": TestModel()},
    )

    assert app.title == "t"


async def test_transcript_endpoints_are_always_mounted(base_env: None) -> None:

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

    app = build_app(minimal_config(), engine=engine(), models={})
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.post("/generations", json={})).status_code == 404


async def test_media_generation_mounts_routes_when_configured(
    base_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """使用对象存储替身隔离外部凭证，验证生成路由已挂载。"""

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

    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("IMAGE_EDIT_URL")

    with pytest.raises(ValidationError, match="IMAGE_EDIT_URL"):
        build_app(config_with_media(), engine=engine(), models={})


class _RecordingConnections(LiveConnections):
    """记录文件变更帧，不创建 WS 连接。"""

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
    """无法解析对话 id 的命名空间不发送会话事件，但写入仍须成功。"""

    live = _RecordingConnections()
    store = AnnouncingFileStore(FakeFileStore(), live)

    written = await store.write("luke/thread-1", "提纲.md", "三幕")

    assert written.version == 1, "文件照样写下去了"
    assert live.announced == []
