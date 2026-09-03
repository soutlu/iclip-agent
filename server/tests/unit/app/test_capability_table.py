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
from tests.helpers.shot_video import FakeObjects

IMAGE_URL = "https://bucket.oss-cn-hangzhou.aliyuncs.com/style.jpg"


def idle_client() -> httpx.AsyncClient:
    """装配面用不到出网，给一个不会被调到的客户端。"""

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
    """名字打错不能静默变成「没挂」——那样 agent 会带着半套工具上线。"""

    with pytest.raises(RuntimeError, match="引用了未登记的 capability 'shots'"):
        resolve_capabilities(("shots",), table=table, declared_by="agent storyboard")


def test_registered_name_resolves(video: Capability[object], table: CapabilityTable) -> None:
    assert resolve_capabilities(("video",), table=table, declared_by="agent storyboard") == (video,)


def test_nothing_declared_mounts_nothing(table: CapabilityTable) -> None:
    assert resolve_capabilities((), table=table, declared_by="agent storyboard") == ()


def test_workspace_is_registered_under_its_declaration_name() -> None:
    """``agents.yaml`` 里写 capabilities: [workspace] 得真能装出工作区来。"""

    built = build_capability_table(workspace_store=FakeFileStore(), http_client=idle_client())
    resolved = resolve_capabilities(("workspace",), table=built, declared_by="agent storyboard")
    assert [type(capability) for capability in resolved] == [Workspace]


def test_shot_video_needs_its_whole_backing() -> None:
    """依赖不齐就不登记这个名字——引用它的 agent 会在装配期响亮地失败。"""

    built = build_capability_table(workspace_store=FakeFileStore(), http_client=idle_client())
    assert "shot_video" not in built
    with pytest.raises(RuntimeError, match="引用了未登记的 capability 'shot_video'"):
        resolve_capabilities(("shot_video",), table=built, declared_by="agent storyboard")


def test_shot_video_is_registered_when_backed(shot_video_settings: ResolvedShotVideo) -> None:
    built = build_capability_table(
        workspace_store=FakeFileStore(),
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
    """镜头素材写的文档要靠工作区的工具让模型看见；少挂一个的失效是静默的，所以装配期就拦。"""

    built = build_capability_table(
        workspace_store=FakeFileStore(),
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
    """十四件工具每件都在注册表里：登记不到的画成朴素的那张卡，而且不报错。

    skill 与派活那两件不在名字表里（一件跟着 skill 库挂，一件跟着子代理声明挂），所以合表时
    单独加上。
    """

    built = build_capability_table(
        workspace_store=FakeFileStore(),
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
        "plan_shot_frames",
        "read_file",
        "search_files",
        "video_parser_md",
        "write_file",
        "write_video_shots",
    ]


def test_a_capability_without_a_table_is_skipped(table: CapabilityTable) -> None:
    """能力包没有 display 表也照样挂得上，它的工具画成朴素的那张卡。"""

    registry = build_display_registry(table)

    assert "read_file" not in registry.entries


async def test_generations_adapter_translates_and_reports_bad_parameters() -> None:
    """画幅与档位的判定归生成域那套唯一的请求定义，适配器只负责把话带到。"""

    adapter = GenerationsAdapter(cast("GenerationService", object()))
    with pytest.raises(InvalidImageRequest, match="aspect_ratio"):
        await adapter.submit(
            cast("Principal", object()),
            ImageRequest(prompt="猫", aspect_ratio="17:9", resolution="1k", channel="dev"),
        )


async def test_generations_adapter_carries_the_conversation_onto_the_job() -> None:
    """工具发起的出图也要归到对话下面，界面才列得出这段对话生成过什么。"""

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


# OSS 的 image/info 真实形状：值一律是字串。
INFO_BODY = {
    "FileSize": {"value": "21839"},
    "Format": {"value": "jpg"},
    "ImageHeight": {"value": "267"},
    "ImageWidth": {"value": "400"},
}


async def test_the_probe_reads_the_oss_image_info() -> None:
    """问的是 image/info，不下载像素；值都是字串，格式要翻成 mime。"""

    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return httpx.Response(200, json=INFO_BODY)

    info = await oss(handler).image_info(IMAGE_URL)

    assert asked == [f"{IMAGE_URL}?x-oss-process=image/info"]
    assert info == ImageInfo(media_type="image/jpeg", size_bytes=21839, width=400, height=267)


async def test_an_unknown_format_keeps_its_own_name() -> None:
    """映射表里没有的格式原样拼成 image/<格式>，不冒充成 jpeg。"""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={**INFO_BODY, "Format": {"value": "bmp"}})

    assert (await oss(handler).image_info(IMAGE_URL)).media_type == "image/bmp"


async def test_a_non_success_status_is_a_probe_failure() -> None:
    """非 2xx 就是问不出来。原因给的是固定中文，它会原样进模型面的错误消息。"""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="NoSuchKey")

    with pytest.raises(MediaProbeFailed, match="对方返回 404"):
        await oss(handler).image_info(IMAGE_URL)


@pytest.mark.parametrize(
    "body", [{"Format": {"value": "jpg"}}, {**INFO_BODY, "ImageWidth": {"value": "宽"}}]
)
async def test_missing_or_unreadable_fields_are_a_probe_failure(body: dict[str, Any]) -> None:
    """字段缺了、或者值不是数，都当问不出来——半份信息算不出该怎么交付。"""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=body)

    with pytest.raises(MediaProbeFailed, match="不是图片信息"):
        await oss(handler).image_info(IMAGE_URL)


async def test_a_non_json_body_is_a_probe_failure() -> None:
    """对方回的是图片本身（比如域名压根不支持处理参数）时也别硬解。"""

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
    """平台层的异常能力包不认识，穿出工具就是整次运行中断；适配器翻成能力包自己的类型。"""

    with pytest.raises(ObjectWriteFailed, match="Read timed out"):
        await ObjectWriterAdapter(_StoreDown()).put_public_object(
            object_key="k", content=b"x", content_type="image/jpeg"
        )

    url = await ObjectWriterAdapter(FakeObjects()).put_public_object(
        object_key="k", content=b"x", content_type="image/jpeg"
    )
    assert url == "https://cdn.test/k"
