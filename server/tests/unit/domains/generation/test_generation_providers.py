"""使用 MockTransport 验证生成供应商的协议映射和重试边界。"""

from __future__ import annotations

import json

import httpx
import pytest

from iclip.domains.generation.image_upstream import task_url
from iclip.domains.generation.nano_banana import (
    NanoBananaImageProvider,
    NanoBananaSettings,
)
from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.seedream import (
    SPEC as SEEDREAM_SPEC,
)
from iclip.domains.generation.seedream import (
    SeedreamImageProvider,
    SeedreamSettings,
)
from iclip.domains.generation.video import HttpVideoProvider, VideoProviderSettings
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.oss import ObjectStoreUnavailable
from tests.helpers.generation import MemoryObjectStore, image_request, make_job, video_request

VIDEO_SETTINGS = VideoProviderSettings(
    submit_url="https://video.test/generate",
    status_base_url="https://video.test/tasks",
    api_key="secret-key",
    model="moyu-seedance-2-5",
    user_name="iclip-agent",
)
IMAGE_API_BASE = "https://image.test/nano-banana-pro"
IMAGE_TEXT_TO_IMAGE_URL = task_url(IMAGE_API_BASE, editing=False)
IMAGE_EDIT_URL = task_url(IMAGE_API_BASE, editing=True)
IMAGE_SETTINGS = NanoBananaSettings(api_base=IMAGE_API_BASE, user_name="iclip-agent")

SEEDREAM_API_BASE = "https://image.test/seedrance5.0pro"
SEEDREAM_TEXT_TO_IMAGE_URL = task_url(SEEDREAM_API_BASE, editing=False)
SEEDREAM_EDIT_URL = task_url(SEEDREAM_API_BASE, editing=True)
SEEDREAM_SETTINGS = SeedreamSettings(api_base=SEEDREAM_API_BASE, user_name="iclip-agent")


def seedream_provider(handler: object, *, store: MemoryObjectStore) -> SeedreamImageProvider:
    assert callable(handler)
    return SeedreamImageProvider(
        SEEDREAM_SETTINGS,
        object_store=store,
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
    )


def seedream_ok(request: httpx.Request) -> httpx.Response:
    if str(request.url) in (SEEDREAM_TEXT_TO_IMAGE_URL, SEEDREAM_EDIT_URL):
        return httpx.Response(200, json={"success": True, "output_str": "https://image.test/o.jpg"})
    return httpx.Response(200, content=b"JPGDATA", headers={"content-type": "image/jpeg"})


def video_provider(handler: object, *, store: MemoryObjectStore | None = None) -> HttpVideoProvider:
    assert callable(handler)
    return HttpVideoProvider(
        VIDEO_SETTINGS,
        object_store=store if store is not None else MemoryObjectStore(),
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
    )


@pytest.mark.parametrize("generate_audio", [True, False, None])
@pytest.mark.parametrize("model", ["moyu-seedance-2-5", "wan3.0-video"])
async def test_video_submit_sends_protocol_payload_and_key(
    generate_audio: bool | None, model: str
) -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("x-api-key")
        seen["body"] = httpx.Response(200, content=request.content).json()
        return httpx.Response(200, json={"task_id": "t-1"})

    job = make_job(
        video_request(
            model=model,
            image_urls=["https://example.test/first.png"],
            reference_video_urls=["https://example.test/reference.mp4"],
            reference_audio_urls=["https://example.test/reference.wav"],
            generate_audio=generate_audio,
        )
    )
    submission = await video_provider(handler).submit(job)

    assert submission.provider_task_id == "t-1"
    assert submission.output_url is None, "异步接口这一步不该有结果"
    assert seen["key"] == "secret-key"
    expected_payload = {
        "model": model,
        "prompt": "一只猫跳上窗台",
        "user_name": "iclip-agent",
        "reference_image_urls": ["https://example.test/first.png"],
        "reference_video_urls": ["https://example.test/reference.mp4"],
        "reference_audio_urls": ["https://example.test/reference.wav"],
        "aspect_ratio": "16:9",
        "seconds": 5,
    }
    if generate_audio is not None:
        expected_payload["generate_audio"] = generate_audio
    assert seen["body"] == expected_payload


async def test_video_poll_maps_terminal_and_running_states() -> None:
    def succeeded(request: httpx.Request) -> httpx.Response:
        if request.url.host == "cdn.test":
            return httpx.Response(200, content=b"MP4", headers={"content-type": "video/mp4"})
        return httpx.Response(
            200,
            json={"status": "succeeded", "result": {"output_url": "https://cdn.test/v.mp4"}},
        )

    def running(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "running"})

    def failed(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"status": "failed", "error": {"code": "NSFW", "message": "被拦了"}}
        )

    job = make_job(provider_task_id="t-1")
    store = MemoryObjectStore()
    done = await video_provider(succeeded, store=store).poll(job)
    assert (
        done.output_url == f"{store.base}/{MEDIA_PATHS.generated_video(job_id=job.id, ext='mp4')}"
    )
    assert (await video_provider(running).poll(job)).outcome == "running"
    rejected = await video_provider(failed).poll(job)
    assert (rejected.outcome, rejected.error_code) == ("failed", "NSFW")
    assert rejected.error_message == "被拦了"


async def test_video_poll_preserves_upstream_error_message() -> None:
    upstream_error = {
        "code": "PROVIDER_ERROR",
        "upstream_status": 422,
        "upstream_code": "InvalidParameter.ReferenceVideo",
        "upstream_message": "Reference video duration exceeds the limit.\n最大时长为 15 秒。",
    }

    def failed(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "failed", "error": upstream_error})

    progress = await video_provider(failed).poll(make_job(provider_task_id="t-1"))

    assert progress.outcome == "failed"
    assert progress.error_code == "PROVIDER_ERROR"
    assert progress.error_message == upstream_error["upstream_message"]
    assert progress.raw["error"] == upstream_error


async def test_video_result_is_rehosted_and_provider_url_is_not_kept() -> None:
    """供应商地址可能过期，成片必须转存为对象存储地址。"""

    store = MemoryObjectStore()
    fetched: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        fetched.append(str(request.url))
        if request.url.host == "cdn.test":
            return httpx.Response(200, content=b"MP4BYTES", headers={"content-type": "video/mp4"})
        return httpx.Response(
            200,
            json={"status": "succeeded", "result": {"output_url": "https://cdn.test/v.mp4?sig=1"}},
        )

    job = make_job(provider_task_id="t-1")
    progress = await video_provider(handler, store=store).poll(job)

    key = MEDIA_PATHS.generated_video(job_id=job.id, ext="mp4")
    assert progress.output_url == f"{store.base}/{key}"
    assert store.objects[key] == (b"MP4BYTES", "video/mp4")
    assert "https://cdn.test/v.mp4?sig=1" in fetched, "provider 的地址只用来下载，不入库"


async def test_video_rehost_failure_fails_the_job_without_retrying() -> None:
    """生成已计费，转存失败不能触发再次生成。"""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "cdn.test":
            return httpx.Response(200, content=b"MP4", headers={"content-type": "video/mp4"})
        return httpx.Response(
            200,
            json={"status": "succeeded", "result": {"output_url": "https://cdn.test/v.mp4"}},
        )

    class BrokenStore(MemoryObjectStore):
        async def put_public_object(
            self, *, object_key: str, content: bytes, content_type: str
        ) -> str:
            raise ObjectStoreUnavailable("桶写不进去")

    with pytest.raises(ProviderError) as error:
        await video_provider(handler, store=BrokenStore()).poll(make_job(provider_task_id="t-1"))
    assert error.value.code == "OUTPUT_STORE_FAILED"
    assert error.value.retryable is False


async def test_video_download_failure_is_not_swallowed() -> None:

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "cdn.test":
            return httpx.Response(404)
        return httpx.Response(
            200,
            json={"status": "succeeded", "result": {"output_url": "https://cdn.test/v.mp4"}},
        )

    with pytest.raises(ProviderError) as error:
        await video_provider(handler).poll(make_job(provider_task_id="t-1"))
    assert error.value.code == "OUTPUT_DOWNLOAD_FAILED"
    assert error.value.retryable is False


async def test_video_poll_rejects_unknown_status() -> None:

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "moderating"})

    with pytest.raises(ProviderError, match="没见过的视频生成状态"):
        await video_provider(handler).poll(make_job(provider_task_id="t-1"))


async def test_video_poll_rejects_success_without_output() -> None:

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "succeeded", "result": {}})

    with pytest.raises(ProviderError, match=r"没给 result\.output_url"):
        await video_provider(handler).poll(make_job(provider_task_id="t-1"))


async def test_video_server_error_is_retryable_but_client_error_is_not() -> None:
    def server_error(_: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="down")

    def bad_request(_: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="bad prompt")

    with pytest.raises(ProviderError) as retryable:
        await video_provider(server_error).submit(make_job())
    assert retryable.value.retryable is True

    with pytest.raises(ProviderError) as permanent:
        await video_provider(bad_request).submit(make_job())
    assert permanent.value.retryable is False


async def test_image_generation_rehosts_result_and_returns_stable_url() -> None:

    store = MemoryObjectStore()
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if str(request.url) == IMAGE_TEXT_TO_IMAGE_URL:
            return httpx.Response(
                200,
                json={"success": True, "output_sign_str": "https://image.test/tmp.png?sig=1"},
            )
        return httpx.Response(200, content=b"PNGDATA", headers={"content-type": "image/png"})

    job = make_job(image_request())
    provider = NanoBananaImageProvider(
        IMAGE_SETTINGS, object_store=store, transport=httpx.MockTransport(handler)
    )
    submission = await provider.submit(job)

    key = MEDIA_PATHS.generated_image(job_id=job.id, ext="png")
    assert submission.output_url == f"{store.base}/{key}"
    assert store.objects[key] == (b"PNGDATA", "image/png")
    assert submission.provider_status == "succeeded", "同步接口提交完就已经是终态"


async def test_image_with_references_uses_edit_endpoint() -> None:
    store = MemoryObjectStore()
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if str(request.url) in (IMAGE_TEXT_TO_IMAGE_URL, IMAGE_EDIT_URL):
            return httpx.Response(
                200, json={"success": True, "output_str": "https://cdn.test/out.jpg"}
            )
        return httpx.Response(200, content=b"JPG", headers={"content-type": "image/jpeg"})

    provider = NanoBananaImageProvider(
        IMAGE_SETTINGS, object_store=store, transport=httpx.MockTransport(handler)
    )
    await provider.submit(
        make_job(image_request(reference_image_urls=["https://example.test/ref.png"]))
    )
    assert paths[0] == httpx.URL(IMAGE_EDIT_URL).path, "有参考图要走编辑那个地址"


async def test_image_never_retries_and_never_switches_channel() -> None:
    """供应商无幂等键，自动重试可能重复计费；渠道价格不同，不能自动切换。"""

    attempts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request.url.path)
        raise httpx.ReadTimeout("timed out", request=request)

    provider = NanoBananaImageProvider(
        IMAGE_SETTINGS,
        object_store=MemoryObjectStore(),
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(ProviderError) as error:
        await provider.submit(make_job(image_request()))
    assert error.value.code == "PROVIDER_RESULT_UNKNOWN"
    assert error.value.retryable is False
    assert len(attempts) == 1, "只调一次，不换渠道再来"


async def test_image_has_no_polling_phase() -> None:
    provider = NanoBananaImageProvider(
        IMAGE_SETTINGS,
        object_store=MemoryObjectStore(),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})),
    )
    with pytest.raises(ProviderError, match="没有轮询阶段"):
        await provider.poll(make_job(image_request()))


@pytest.mark.parametrize("channel", ["dev", "pro"])
async def test_image_sends_the_channel_from_the_request(channel: str) -> None:

    sent: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) in (IMAGE_TEXT_TO_IMAGE_URL, IMAGE_EDIT_URL):
            sent.update(httpx.Response(200, content=request.content).json())
            return httpx.Response(
                200, json={"success": True, "output_str": "https://cdn.test/out.png"}
            )
        return httpx.Response(200, content=b"PNG", headers={"content-type": "image/png"})

    provider = NanoBananaImageProvider(
        IMAGE_SETTINGS,
        object_store=MemoryObjectStore(),
        transport=httpx.MockTransport(handler),
    )
    submission = await provider.submit(make_job(image_request(channel=channel)))

    assert sent["channel"] == channel
    assert submission.raw["channel"] == channel, "落库的快照要记下实际走的渠道"


async def test_video_model_comes_from_the_request_when_given() -> None:
    sent: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent.update(httpx.Response(200, content=request.content).json())
        return httpx.Response(200, json={"task_id": "t-1"})

    submission = await video_provider(handler).submit(
        make_job(video_request(model="mmt-seedance-3-0"))
    )
    assert sent["model"] == "mmt-seedance-3-0"
    assert submission.raw["model"] == "mmt-seedance-3-0", "落库的快照要记下实际用的模型"


async def test_video_falls_back_to_the_configured_default_model() -> None:
    """默认模型会随配置变化，解析后的实际模型也须持久化到请求快照。"""

    sent: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent.update(httpx.Response(200, content=request.content).json())
        return httpx.Response(200, json={"task_id": "t-1"})

    submission = await video_provider(handler).submit(make_job(video_request()))
    assert sent["model"] == VIDEO_SETTINGS.model
    assert submission.raw["model"] == VIDEO_SETTINGS.model


async def test_image_edit_sends_the_urls_in_the_order_the_caller_gave() -> None:
    """编号由图片顺序决定，所以顺序必须原样发出；帧号只是我们自己的标签，不外发。"""

    request = image_request(
        prompt="把【输入图片 2 中的标注 1】的杯子换成红色",
        reference_image_urls=["https://cdn.test/frame.png", "https://cdn.test/annotated.png"],
        shot_index=3,
        frame_number=2,
    )
    sent: dict[str, object] = {}

    def handler(http_request: httpx.Request) -> httpx.Response:
        if str(http_request.url) == IMAGE_EDIT_URL:
            sent.update(httpx.Response(200, content=http_request.content).json())
            return httpx.Response(
                200, json={"success": True, "output_str": "https://cdn.test/out.png"}
            )
        return httpx.Response(200, content=b"PNG", headers={"content-type": "image/png"})

    provider = NanoBananaImageProvider(
        IMAGE_SETTINGS, object_store=MemoryObjectStore(), transport=httpx.MockTransport(handler)
    )
    await provider.submit(make_job(request))
    assert sent["input_str_list"] == request.reference_image_urls
    assert sent["prompt"] == request.prompt
    assert set(sent) == {
        "data_id",
        "user_name",
        "prompt",
        "task_source",
        "aspect_ratio",
        "resolution",
        "channel",
        "input_str_list",
    }


async def test_seedream_sends_a_pixel_size_and_no_channel() -> None:
    """上游只收一个同时表达画幅与分辨率的像素 size，也没有渠道这个轴。"""

    sent: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == SEEDREAM_TEXT_TO_IMAGE_URL:
            sent.append(json.loads(request.content))
        return seedream_ok(request)

    store = MemoryObjectStore()
    job = make_job(image_request(aspect_ratio="9:16", resolution="2k"))
    submission = await seedream_provider(handler, store=store).submit(job)

    assert set(sent[0]) == {
        "data_id",
        "user_name",
        "prompt",
        "task_source",
        "size",
        "output_format",
    }, "键集变了就是上游合同变了"
    assert sent[0]["size"] == "1584*2816"
    assert submission.provider_task_id == str(job.id), "上游不回任务 id，用 data_id 对账"

    key = MEDIA_PATHS.generated_image(job_id=job.id, ext="jpg")
    assert submission.output_url == f"{store.base}/{key}"


@pytest.mark.parametrize(
    ("aspect_ratio", "resolution", "size"),
    [
        ("1:1", "1k", "1024*1024"),
        ("1:1", "2k", "2048*2048"),
        ("3:2", "1k", "1248*832"),
        ("2:3", "1k", "832*1248"),
        ("3:4", "2k", "1776*2368"),
        ("4:3", "2k", "2368*1776"),
        ("16:9", "1k", "1424*800"),
        ("21:9", "2k", "3136*1344"),
    ],
)
async def test_seedream_translates_every_declared_ratio_and_tier(
    aspect_ratio: str, resolution: str, size: str
) -> None:
    sent: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == SEEDREAM_TEXT_TO_IMAGE_URL:
            sent.append(json.loads(request.content))
        return seedream_ok(request)

    await seedream_provider(handler, store=MemoryObjectStore()).submit(
        make_job(image_request(aspect_ratio=aspect_ratio, resolution=resolution))
    )
    assert sent[0]["size"] == size


async def test_seedream_declares_exactly_what_it_can_translate() -> None:
    """能力声明由那张映射表的键推导，两处不可能漂。"""

    assert SEEDREAM_SPEC.resolutions == ("1k", "2k"), "上游没有 4k"
    assert "4:5" not in SEEDREAM_SPEC.aspect_ratios
    assert "5:4" not in SEEDREAM_SPEC.aspect_ratios
    assert SEEDREAM_SPEC.channels == (), "没有渠道这个轴"

    sent: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == SEEDREAM_TEXT_TO_IMAGE_URL:
            sent.append(json.loads(request.content))
        return seedream_ok(request)

    provider = seedream_provider(handler, store=MemoryObjectStore())
    for aspect_ratio in SEEDREAM_SPEC.aspect_ratios:
        for resolution in SEEDREAM_SPEC.resolutions:
            await provider.submit(
                make_job(image_request(aspect_ratio=aspect_ratio, resolution=resolution))
            )
    assert len(sent) == len(SEEDREAM_SPEC.aspect_ratios) * len(SEEDREAM_SPEC.resolutions)


async def test_seedream_with_references_uses_the_edit_endpoint_in_order() -> None:
    urls: list[str] = []
    sent: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        if str(request.url) == SEEDREAM_EDIT_URL:
            sent.append(json.loads(request.content))
        return seedream_ok(request)

    references = ["https://cdn.test/a.png", "https://cdn.test/b.png"]
    await seedream_provider(handler, store=MemoryObjectStore()).submit(
        make_job(image_request(reference_image_urls=references))
    )

    assert urls[0] == SEEDREAM_EDIT_URL, "有参考图要走编辑那个地址"
    assert sent[0]["input_str_list"] == references, "顺序即 prompt 里 image 1 / image 2 的编号"


async def test_seedream_has_no_polling_phase() -> None:
    provider = seedream_provider(seedream_ok, store=MemoryObjectStore())
    with pytest.raises(ProviderError, match="同步"):
        await provider.poll(make_job(image_request()))
