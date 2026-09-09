"""使用 MockTransport 验证生成供应商的协议映射和重试边界。"""

from __future__ import annotations

import json
import uuid

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
from tests.helpers.generation import (
    SHOT_IMAGE_URLS,
    SHOT_PROMPT,
    MemoryObjectStore,
    image_request,
    make_job,
    video_request,
    video_shot,
)

VIDEO_SETTINGS = VideoProviderSettings(
    submit_url="https://video.test/generate",
    status_base_url="https://video.test/tasks",
    api_key="secret-key",
)
IMAGE_API_BASE = "https://image.test/nano-banana-pro"
IMAGE_TEXT_TO_IMAGE_URL = task_url(IMAGE_API_BASE, editing=False)
IMAGE_EDIT_URL = task_url(IMAGE_API_BASE, editing=True)
IMAGE_SETTINGS = NanoBananaSettings(api_base=IMAGE_API_BASE, env="test")

SEEDREAM_API_BASE = "https://image.test/seedrance5.0pro"
SEEDREAM_TEXT_TO_IMAGE_URL = task_url(SEEDREAM_API_BASE, editing=False)
SEEDREAM_EDIT_URL = task_url(SEEDREAM_API_BASE, editing=True)
SEEDREAM_SETTINGS = SeedreamSettings(api_base=SEEDREAM_API_BASE, env="test")


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


def video_provider(handler: object) -> HttpVideoProvider:
    assert callable(handler)
    return HttpVideoProvider(
        VIDEO_SETTINGS,
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
    )


SUCCEEDED_RESULT = {
    "output_url": "https://cdn.test/v.mp4",
    "watermark_output_url": "https://cdn.test/v-wm.mp4",
}


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
            reference_image_urls=["https://example.test/first.png"],
            reference_video_urls=["https://example.test/reference.mp4"],
            reference_audio_urls=["https://example.test/reference.wav"],
            generate_audio=generate_audio,
            conversation_id=uuid.uuid4(),
            shot_index=2,
            task_id=uuid.uuid4(),
        )
    )
    submission = await video_provider(handler).submit(job)

    assert submission.provider_task_id == "t-1"
    assert submission.output_url is None, "异步接口这一步不该有结果"
    assert seen["key"] == "secret-key"
    expected_payload = {
        "model": model,
        "prompt": "一只猫跳上窗台",
        "user_name": "luke",
        "reference_image_urls": ["https://example.test/first.png"],
        "reference_video_urls": ["https://example.test/reference.mp4"],
        "reference_audio_urls": ["https://example.test/reference.wav"],
        "aspect_ratio": "16:9",
        "seconds": 5,
    }
    if generate_audio is not None:
        expected_payload["generate_audio"] = generate_audio
    assert seen["body"] == expected_payload, "请求原样转发：没给的不发，归属字段不发"


async def test_video_submit_forwards_the_assembled_prompt_but_not_the_shot() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = httpx.Response(200, content=request.content).json()
        return httpx.Response(200, json={"task_id": "t-2"})

    job = make_job(
        video_request(
            prompt=None, shot=video_shot(), reference_image_urls=SHOT_IMAGE_URLS, seconds=6
        )
    )
    await video_provider(handler).submit(job)

    assert seen["body"] == {
        "model": "moyu-seedance-2-5",
        "prompt": SHOT_PROMPT,
        "user_name": "luke",
        "reference_image_urls": SHOT_IMAGE_URLS,
        "reference_video_urls": [],
        "reference_audio_urls": [],
        "aspect_ratio": "16:9",
        "seconds": 6,
    }, "上游只认正文：shot 拼进 prompt 后不再出现在请求里"


async def test_video_submit_passes_provider_options_and_resolution_through() -> None:
    sent: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent.update(httpx.Response(200, content=request.content).json())
        return httpx.Response(200, json={"task_id": "t-1"})

    await video_provider(handler).submit(
        make_job(
            video_request(
                resolution="1440p-SR", seconds=-1, provider_options={"output_format": "mov"}
            )
        )
    )
    assert (sent["resolution"], sent["seconds"]) == ("1440p-SR", -1)
    assert sent["provider_options"] == {"output_format": "mov"}


async def test_video_submit_tells_unreachable_from_result_unknown() -> None:
    """连不上可以确定没发出去；发出去了没拿到结果不能确定，两种码不能混。查状态是幂等的，照旧可重试。"""

    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    def hung(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    with pytest.raises(ProviderError) as unreachable:
        await video_provider(refused).submit(make_job())
    assert (unreachable.value.code, unreachable.value.retryable) == ("PROVIDER_UNREACHABLE", True)

    with pytest.raises(ProviderError) as unknown:
        await video_provider(hung).submit(make_job())
    assert (unknown.value.code, unknown.value.retryable) == ("PROVIDER_RESULT_UNKNOWN", False)

    with pytest.raises(ProviderError) as polling:
        await video_provider(hung).poll(make_job(provider_task_id="t-1"))
    assert (polling.value.code, polling.value.retryable) == ("PROVIDER_UNREACHABLE", True)


async def test_video_poll_asks_with_the_requests_user_name() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"status": "running"})

    await video_provider(handler).poll(
        make_job(video_request(user_name="designer-zhang"), provider_task_id="t/1")
    )
    assert seen["url"] == "https://video.test/tasks/t%2F1?user_name=designer-zhang"


async def test_video_poll_maps_terminal_and_running_states() -> None:
    fetched: list[str] = []

    def succeeded(request: httpx.Request) -> httpx.Response:
        fetched.append(request.url.host)
        return httpx.Response(200, json={"status": "succeeded", "result": SUCCEEDED_RESULT})

    def running(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "running"})

    def failed(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"status": "failed", "error": {"code": "NSFW", "message": "被拦了"}}
        )

    job = make_job(provider_task_id="t-1")
    done = await video_provider(succeeded).poll(job)
    assert (done.output_url, done.watermark_output_url) == (
        SUCCEEDED_RESULT["output_url"],
        SUCCEEDED_RESULT["watermark_output_url"],
    ), "上游发布好的地址直接存，不转存"
    assert fetched == ["video.test"], "只问了状态，没去下载成片"
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


async def test_video_poll_rejects_unknown_status() -> None:

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "moderating"})

    with pytest.raises(ProviderError, match="没见过的视频生成状态"):
        await video_provider(handler).poll(make_job(provider_task_id="t-1"))


@pytest.mark.parametrize(
    ("result", "missing"),
    [
        ({}, "result.output_url / result.watermark_output_url"),
        ({"output_url": "https://cdn.test/v.mp4"}, "result.watermark_output_url"),
        ({"watermark_output_url": "https://cdn.test/v-wm.mp4"}, "result.output_url"),
    ],
)
async def test_video_poll_rejects_success_without_both_outputs(
    result: dict[str, str], missing: str
) -> None:
    """上游两份产物都发布完才进 succeeded，缺一份就是协议错，判失败不留半份。"""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "succeeded", "result": result})

    with pytest.raises(ProviderError) as error:
        await video_provider(handler).poll(make_job(provider_task_id="t-1"))
    assert error.value.code == "PROVIDER_OUTPUT_MISSING"
    assert missing in str(error.value)


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

    job = make_job(image_request(channel="dev"))
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
        make_job(
            image_request(channel="dev", reference_image_urls=["https://example.test/ref.png"])
        )
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
        await provider.submit(make_job(image_request(channel="dev")))
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
    assert submission.raw == {"response": {"task_id": "t-1"}}, "模型在请求快照里，回执只存上游响应"


async def test_image_edit_sends_the_urls_in_the_order_the_caller_gave() -> None:
    """编号由图片顺序决定，所以顺序必须原样发出；帧号只是我们自己的标签，不外发。"""

    request = image_request(
        channel="dev",
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
    assert sent["user_name"] == "luke", "对账的名字来自请求，不再是配置里写死的"
    assert set(sent) == {
        "data_id",
        "user_name",
        "prompt",
        "task_source",
        "env",
        "aspect_ratio",
        "resolution",
        "channel",
        "input_str_list",
    }
    assert (sent["task_source"], sent["env"]) == ("iclip_agent", "test")


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
        "env",
        "size",
        "output_format",
    }, "键集变了就是上游合同变了"
    assert (sent[0]["task_source"], sent[0]["env"]) == ("iclip_agent", "test")
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


async def test_nano_refuses_to_send_a_null_channel() -> None:
    """这家声明了渠道轴，受理层会填好；真为空说明装配串了，不能给付费接口送 null。"""

    provider = NanoBananaImageProvider(
        IMAGE_SETTINGS,
        object_store=MemoryObjectStore(),
        transport=httpx.MockTransport(lambda _request: httpx.Response(500)),
    )
    with pytest.raises(ProviderError, match="没有渠道"):
        await provider.submit(make_job(image_request(channel=None)))
