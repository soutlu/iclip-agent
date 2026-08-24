"""T-GEN-02 / T-GEN-03：两家生成接口的协议映射与重试边界。

不打真网络：httpx 的 ``MockTransport`` 直接扮演对方（同 identity 的 SSO/PMS 用例）。
这里验的是「对方这样回，我们就该那样理解」，以及**什么情况下不许重试**。
"""

from __future__ import annotations

import httpx
import pytest

from iclip.domains.generation.multiflow import MultiflowSettings, MultiflowVideoProvider
from iclip.domains.generation.nano_banana import (
    NanoBananaImageProvider,
    NanoBananaSettings,
)
from iclip.domains.generation.provider import ProviderError
from tests.helpers.generation import MemoryObjectStore, image_request, make_job, video_request

VIDEO_SETTINGS = MultiflowSettings(
    submit_url="https://video.test/generate",
    status_base_url="https://video.test/tasks",
    api_key="secret-key",
    model="seedance",
    user_name="iclip-agent",
)
IMAGE_TEXT_TO_IMAGE_URL = "https://image.test/text-to-image"
IMAGE_EDIT_URL = "https://image.test/image-edit"
IMAGE_SETTINGS = NanoBananaSettings(
    text_to_image_url=IMAGE_TEXT_TO_IMAGE_URL,
    image_edit_url=IMAGE_EDIT_URL,
    user_name="iclip-agent",
)


def video_provider(handler: object) -> MultiflowVideoProvider:
    assert callable(handler)
    return MultiflowVideoProvider(
        VIDEO_SETTINGS,
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
    )


async def test_video_submit_sends_protocol_payload_and_key() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("x-api-key")
        seen["body"] = httpx.Response(200, content=request.content).json()
        return httpx.Response(200, json={"task_id": "t-1"})

    job = make_job(video_request(image_urls=["https://example.test/first.png"]))
    submission = await video_provider(handler).submit(job)

    assert submission.provider_task_id == "t-1"
    assert submission.output_url is None, "异步接口这一步不该有结果"
    assert seen["key"] == "secret-key"
    assert seen["body"] == {
        "model": "seedance",
        "prompt": "一只猫跳上窗台",
        "user_name": "iclip-agent",
        "image_urls": ["https://example.test/first.png"],
        "reference_videos": [],
        "reference_audios": [],
        "aspect_ratio": "16:9",
        "seconds": 5,
    }


async def test_video_poll_maps_terminal_and_running_states() -> None:
    def succeeded(_: httpx.Request) -> httpx.Response:
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
    assert (await video_provider(succeeded).poll(job)).output_url == "https://cdn.test/v.mp4"
    assert (await video_provider(running).poll(job)).outcome == "running"
    rejected = await video_provider(failed).poll(job)
    assert (rejected.outcome, rejected.error_code) == ("failed", "NSFW")


async def test_video_poll_rejects_unknown_status() -> None:
    """没见过的状态不当成「还在跑」——那会让一个已经结束的任务永远轮询下去。"""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "moderating"})

    with pytest.raises(ProviderError, match="没见过的视频生成状态"):
        await video_provider(handler).poll(make_job(provider_task_id="t-1"))


async def test_video_poll_rejects_success_without_output() -> None:
    """说成功却没给结果是协议破了，必须响亮失败，不能当成还在跑。"""

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
    """结果图转存到我们自己的对象存储：库里存的地址不会随签名过期而烂掉。"""

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

    assert submission.output_url == f"{store.base}/generated-images/{job.id}.png"
    assert store.objects[f"generated-images/{job.id}.png"] == (b"PNGDATA", "image/png")
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
    """一次调用，报错就是报错。

    这家没有幂等键，一次成功的生成就是一次计费；而两个渠道价钱还不一样，替调用方偷
    偷换一个等于悄悄改了这次花多少钱。错误码分得清「送到了没有」，是给人做决定用的，
    不驱动自动动作。
    """

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
    """渠道是调用方的决定（两个渠道价钱不一样），不由我们挑。"""

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
    """请求没指定就用配置里的默认模型——但配置将来会改，所以快照里也记一份。"""

    sent: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent.update(httpx.Response(200, content=request.content).json())
        return httpx.Response(200, json={"task_id": "t-1"})

    submission = await video_provider(handler).submit(make_job(video_request()))
    assert sent["model"] == VIDEO_SETTINGS.model
    assert submission.raw["model"] == VIDEO_SETTINGS.model
