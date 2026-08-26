"""capability 按名字解析，名字没登记即装配期报错。"""

from __future__ import annotations

from typing import cast

import httpx
import pytest
from pydantic_ai.capabilities import Capability

from iclip.app.capability_table import (
    CapabilityTable,
    GenerationsAdapter,
    ObjectWriterAdapter,
    build_capability_table,
    resolve_capabilities,
)
from iclip.capabilities.shot_video.capability import ShotVideo
from iclip.capabilities.shot_video.ports import (
    ImageRequest,
    InvalidImageRequest,
    ObjectWriteFailed,
)
from iclip.capabilities.workspace.capability import Workspace
from iclip.config import ResolvedShotVideo
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal
from iclip.platform.object_store.oss import ObjectStoreUnavailable
from tests.helpers.file_store import FakeFileStore
from tests.helpers.shot_video import FakeObjects


@pytest.fixture
def shot_video_settings() -> ResolvedShotVideo:
    return ResolvedShotVideo(
        understanding_url="https://vision.test/responses",
        understanding_api_key="ark",
        understanding_model="seed-vision",
        understanding_thinking="medium",
        understanding_fps=5,
        poll_interval_seconds=5.0,
        dev_attempts=2,
        pro_attempts=1,
        backoff_seconds=5.0,
        backoff_factor=3.0,
        job_timeout_seconds=1800.0,
    )


@pytest.fixture
def video() -> Capability[object]:
    return Capability[object](id="video", instructions="按镜头表干活。")


@pytest.fixture
def table(video: Capability[object]) -> CapabilityTable:
    return {"video": (video,)}


def test_unknown_name_fails_loudly(table: CapabilityTable) -> None:
    """名字打错不能静默变成「没挂」——那样 agent 会带着半套工具上线。"""

    with pytest.raises(RuntimeError, match="引用了未登记的 capability 'shots'"):
        resolve_capabilities(("shots",), table=table, declared_by="agent storyboard")


def test_registered_name_resolves(video: Capability[object], table: CapabilityTable) -> None:
    assert resolve_capabilities(("video",), table=table, declared_by="agent storyboard") == (video,)


def test_nothing_declared_mounts_nothing(table: CapabilityTable) -> None:
    assert resolve_capabilities((), table=table, declared_by="agent storyboard") == ()


def test_workspace_is_registered_under_its_declaration_name() -> None:
    """``agents.yaml`` 里写 capabilities: [workspace] 得真能装出工作区来。"""

    built = build_capability_table(workspace_store=FakeFileStore())
    resolved = resolve_capabilities(("workspace",), table=built, declared_by="agent storyboard")
    assert [type(capability) for capability in resolved] == [Workspace]


def test_shot_video_needs_its_whole_backing() -> None:
    """依赖不齐就不登记这个名字——引用它的 agent 会在装配期响亮地失败。"""

    built = build_capability_table(workspace_store=FakeFileStore())
    assert "shot_video" not in built
    with pytest.raises(RuntimeError, match="引用了未登记的 capability 'shot_video'"):
        resolve_capabilities(("shot_video",), table=built, declared_by="agent storyboard")


def test_shot_video_is_registered_when_backed(shot_video_settings: ResolvedShotVideo) -> None:
    built = build_capability_table(
        workspace_store=FakeFileStore(),
        generation_service=cast("GenerationService", object()),
        object_store=FakeObjects(),
        http_client=cast("httpx.AsyncClient", object()),
        shot_video=shot_video_settings,
    )
    resolved = resolve_capabilities(
        ("workspace", "shot_video"), table=built, declared_by="agent storyboard"
    )
    assert [type(capability) for capability in resolved] == [Workspace, ShotVideo]


def test_shot_video_without_workspace_fails_at_assembly(
    shot_video_settings: ResolvedShotVideo,
) -> None:
    """镜头素材写的文档要靠工作区的工具让模型看见；少挂一个的失效是静默的，所以装配期就拦。"""

    built = build_capability_table(
        workspace_store=FakeFileStore(),
        generation_service=cast("GenerationService", object()),
        object_store=FakeObjects(),
        http_client=cast("httpx.AsyncClient", object()),
        shot_video=shot_video_settings,
    )
    with pytest.raises(RuntimeError, match=r"没挂 'workspace'.*agents\.yaml"):
        resolve_capabilities(("shot_video",), table=built, declared_by="agent storyboard")


async def test_generations_adapter_translates_and_reports_bad_parameters() -> None:
    """画幅与档位的判定归生成域那套唯一的请求定义，适配器只负责把话带到。"""

    adapter = GenerationsAdapter(cast("GenerationService", object()))
    with pytest.raises(InvalidImageRequest, match="aspect_ratio"):
        await adapter.submit(
            cast("Principal", object()),
            ImageRequest(prompt="猫", aspect_ratio="17:9", resolution="1k", channel="dev"),
        )


class _StoreDown:
    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        _ = (object_key, content, content_type)
        raise ObjectStoreUnavailable("OSS 写入失败（试了 3 次）: Read timed out")


async def test_object_writer_adapter_translates_the_failure_and_passes_urls_through() -> None:
    """平台层的异常能力包不认识，穿出工具就是整次运行中断；适配器翻成能力包自己的类型。"""

    with pytest.raises(ObjectWriteFailed, match="Read timed out"):
        await ObjectWriterAdapter(_StoreDown()).put_public_object(
            object_key="k", content=b"x", content_type="image/jpeg"
        )

    url = await ObjectWriterAdapter(FakeObjects()).put_public_object(
        object_key="k", content=b"x", content_type="image/jpeg"
    )
    assert url == "https://cdn.test/k"
