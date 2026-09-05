"""使用 MockTransport 验证生成供应商的协议映射和重试边界。"""

from __future__ import annotations

import httpx
import pytest

from iclip.domains.generation.multiflow import MultiflowSettings, MultiflowVideoProvider
from iclip.domains.generation.nano_banana import (
    NanoBananaImageProvider,
    NanoBananaSettings,
)
from iclip.domains.generation.provider import ProviderError
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.oss import ObjectStoreUnavailable
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


def video_provider(
    handler: object, *, store: MemoryObjectStore | None = None
) -> MultiflowVideoProvider:
    assert callable(handler)
    return MultiflowVideoProvider(
        VIDEO_SETTINGS,
        object_store=store if store is not None else MemoryObjectStore(),
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
