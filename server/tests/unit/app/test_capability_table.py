"""capability 按名字解析，名字没登记即装配期报错。"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any, cast

import httpx
import pytest
from pydantic_ai.capabilities import Capability

from iclip.app.capability_table import (
    CapabilityTable,
    GenerationsAdapter,
    ObjectWriterAdapter,
    OssMediaProbe,
    build_capability_table,
    build_display_registry,
    resolve_capabilities,
)
from iclip.capabilities.shot_video.capability import ShotVideo
from iclip.capabilities.shot_video.ports import (
    ImageRequest,
    InvalidImageRequest,
    ObjectWriteFailed,
)
from iclip.capabilities.workspace.capability import Workspace
from iclip.capabilities.workspace.ports import ImageInfo, MediaProbeFailed
from iclip.config import ResolvedShotVideo
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal
from iclip.platform.object_store.oss import ObjectStoreUnavailable
from tests.helpers.file_store import FakeFileStore
from tests.helpers.generation import make_job
from tests.helpers.material_ledger import FakeMaterialLedger
from tests.helpers.shot_video import FakeObjects

IMAGE_URL = "https://bucket.oss-cn-hangzhou.aliyuncs.com/style.jpg"


def idle_client() -> httpx.AsyncClient:
    """装配测试不发送网络请求。"""

    return httpx.AsyncClient()


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

    with pytest.raises(RuntimeError, match="引用了未登记的 capability 'shots'"):
        resolve_capabilities(("shots",), table=table, declared_by="agent storyboard")


def test_registered_name_resolves(video: Capability[object], table: CapabilityTable) -> None:
    assert resolve_capabilities(("video",), table=table, declared_by="agent storyboard") == (video,)


def test_nothing_declared_mounts_nothing(table: CapabilityTable) -> None:
    assert resolve_capabilities((), table=table, declared_by="agent storyboard") == ()


def test_workspace_is_registered_under_its_declaration_name() -> None:

    built = build_capability_table(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        http_client=idle_client(),
    )
    resolved = resolve_capabilities(("workspace",), table=built, declared_by="agent storyboard")
    assert [type(capability) for capability in resolved] == [Workspace]


def test_shot_video_needs_its_whole_backing() -> None:

    built = build_capability_table(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        http_client=idle_client(),
    )
    assert "shot_video" not in built
    with pytest.raises(RuntimeError, match="引用了未登记的 capability 'shot_video'"):
        resolve_capabilities(("shot_video",), table=built, declared_by="agent storyboard")


def test_shot_video_is_registered_when_backed(shot_video_settings: ResolvedShotVideo) -> None:
    built = build_capability_table(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        generation_service=cast("GenerationService", object()),
        object_store=FakeObjects(),
        http_client=idle_client(),
        shot_video=shot_video_settings,
    )
    resolved = resolve_capabilities(
        ("workspace", "shot_video"), table=built, declared_by="agent storyboard"
    )
    assert [type(capability) for capability in resolved] == [Workspace, ShotVideo]


def test_shot_video_without_workspace_fails_at_assembly(
    shot_video_settings: ResolvedShotVideo,
) -> None:
    """镜头素材产物依赖工作区工具读取，缺少工作区能力须在装配时拒绝。"""

    built = build_capability_table(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        generation_service=cast("GenerationService", object()),
        object_store=FakeObjects(),
        http_client=idle_client(),
        shot_video=shot_video_settings,
    )
    with pytest.raises(RuntimeError, match=r"没挂 'workspace'.*agents\.yaml"):
        resolve_capabilities(("shot_video",), table=built, declared_by="agent storyboard")


def test_the_display_registry_covers_every_mounted_tool(
    shot_video_settings: ResolvedShotVideo,
) -> None:
    """合并 display 表时需包含不在能力名称表中的 skill 和子代理工具。"""

    built = build_capability_table(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        generation_service=cast("GenerationService", object()),
        object_store=FakeObjects(),
        http_client=idle_client(),
        shot_video=shot_video_settings,
    )

    registry = build_display_registry(built)

    assert sorted(registry.entries) == [
        "ReadMediaFile",
        "delegate_task",
        "delete_file",
        "edit_file",
        "generate_anchor_sheet",
        "generate_shot_frames",
        "get_skill_reference",
        "list_files",
        "load_capability",
        "plan_shot_frames",
        "read_file",
        "search_files",
        "video_parser_md",
        "write_file",
        "write_video_shots",
    ]


def test_a_capability_without_a_table_is_skipped(table: CapabilityTable) -> None:

    registry = build_display_registry(table)

    assert "read_file" not in registry.entries


async def test_generations_adapter_translates_and_reports_bad_parameters() -> None:
    """生成域定义请求约束，适配器负责映射参数与错误。"""

    adapter = GenerationsAdapter(cast("GenerationService", object()))
    with pytest.raises(InvalidImageRequest, match="aspect_ratio"):
        await adapter.submit(
            cast("Principal", object()),
            ImageRequest(prompt="猫", aspect_ratio="17:9", resolution="1k", channel="dev"),
        )


async def test_generations_adapter_carries_the_conversation_onto_the_job() -> None:

    seen: list[ImageGenerationIn] = []

    class _Recording:
        async def submit(self, principal: Principal, request: ImageGenerationIn) -> GenerationJob:
            _ = principal
            seen.append(request)
            return make_job(request)

    conversation_id = uuid.uuid4()
    adapter = GenerationsAdapter(cast("GenerationService", _Recording()))
    await adapter.submit(
        cast("Principal", object()),
        ImageRequest(
            prompt="猫",
            aspect_ratio="1:1",
            resolution="1k",
            channel="dev",
            conversation_id=str(conversation_id),
        ),
    )
    assert seen[0].conversation_id == conversation_id


class _StoreDown:
    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        _ = (object_key, content, content_type)
        raise ObjectStoreUnavailable("OSS 写入失败（试了 3 次）: Read timed out")


def oss(handler: Callable[[httpx.Request], httpx.Response]) -> OssMediaProbe:
    return OssMediaProbe(httpx.AsyncClient(transport=httpx.MockTransport(handler)))


# OSS image/info 的字段值均为字符串。
INFO_BODY = {
    "FileSize": {"value": "21839"},
    "Format": {"value": "jpg"},
    "ImageHeight": {"value": "267"},
    "ImageWidth": {"value": "400"},
}


async def test_the_probe_reads_the_oss_image_info() -> None:

    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return httpx.Response(200, json=INFO_BODY)

    info = await oss(handler).image_info(IMAGE_URL)

    assert asked == [f"{IMAGE_URL}?x-oss-process=image/info"]
    assert info == ImageInfo(media_type="image/jpeg", size_bytes=21839, width=400, height=267)


async def test_an_unknown_format_keeps_its_own_name() -> None:

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={**INFO_BODY, "Format": {"value": "bmp"}})

    assert (await oss(handler).image_info(IMAGE_URL)).media_type == "image/bmp"


async def test_a_non_success_status_is_a_probe_failure() -> None:

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="NoSuchKey")

    with pytest.raises(MediaProbeFailed, match="对方返回 404"):
        await oss(handler).image_info(IMAGE_URL)


@pytest.mark.parametrize(
    "body", [{"Format": {"value": "jpg"}}, {**INFO_BODY, "ImageWidth": {"value": "宽"}}]
)
async def test_missing_or_unreadable_fields_are_a_probe_failure(body: dict[str, Any]) -> None:

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=body)

    with pytest.raises(MediaProbeFailed, match="不是图片信息"):
        await oss(handler).image_info(IMAGE_URL)


async def test_a_non_json_body_is_a_probe_failure() -> None:

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"\xff\xd8\xff\xe0")

    with pytest.raises(MediaProbeFailed, match="不是图片信息"):
        await oss(handler).image_info(IMAGE_URL)


async def test_a_network_failure_is_a_probe_failure() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with pytest.raises(MediaProbeFailed, match="地址访问不到"):
        await oss(handler).image_info(IMAGE_URL)


async def test_object_writer_adapter_translates_the_failure_and_passes_urls_through() -> None:
    """适配器须转换平台异常为能力包异常，避免可处理的工具错误中断整个运行。"""

    with pytest.raises(ObjectWriteFailed, match="Read timed out"):
        await ObjectWriterAdapter(_StoreDown()).put_public_object(
            object_key="k", content=b"x", content_type="image/jpeg"
        )

    url = await ObjectWriterAdapter(FakeObjects()).put_public_object(
        object_key="k", content=b"x", content_type="image/jpeg"
    )
    assert url == "https://cdn.test/k"
