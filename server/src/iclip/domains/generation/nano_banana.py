"""图像生成 provider。

这家接口是**同步**的：一次 POST 等到图出来，最长几分钟。所以它没有轮询阶段——
``submit`` 直接带着结果回来，``poll`` 永远不该被调到。

  POST {text_to_image_url}   没有参考图时
  POST {image_edit_url}      有参考图时
  → {"success": true, "output_sign_str"|"output_str": "https://…"}

**两个地址连路径一起来自环境变量**，仓里不留对方的接口路由：这是个公开仓，不该说清
我们在调谁的哪个内部接口。

对方返回的是会过期的签名 URL，所以拿到就下载下来转存成我们自己的公开对象，库里存
那个不会烂的地址。

**一次调用，报错就是报错，不自动重试也不换渠道。** 这家没有幂等键，一次成功的生成
就是一次计费；而 ``dev`` / ``pro`` 两个渠道价钱还不一样，替调用方偷偷换一个等于悄悄
改了这次生成花多少钱——和「悄悄重投一次」是同一类毛病。渠道是请求里带来的参数，由调
用方决定；这次失败了就把失败照实记下来，让人看着错误码决定要不要再发一次。

失败的错误码分得清「送到了没有」（``PROVIDER_UNREACHABLE`` 是连都没连上、可以放心重
发；``PROVIDER_RESULT_UNKNOWN`` 是发出去了但没拿到结果、可能已经计费，得先跟对方核
对）。这两条不再触发任何自动动作，它们存在是为了让人做那个决定。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import urlsplit

import httpx

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
)
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.platform.object_store.oss import ObjectStoreUnavailable, PublicObjectStore

PROVIDER_NAME: Final = "nano_banana_pro"

_TASK_SOURCE: Final = "iClip"

_GENERATE_TIMEOUT_SECONDS: Final = 300.0
_DOWNLOAD_TIMEOUT_SECONDS: Final = 60.0
_MAX_IMAGE_BYTES: Final = 64 * 1024 * 1024

_OBJECT_KEY_PREFIX: Final = "generated-images"
_MIME_BY_SUFFIX: Final = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
}
_SUFFIX_BY_MIME: Final = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
}
_DEFAULT_MIME: Final = "image/png"


@dataclass(frozen=True, slots=True)
class NanoBananaSettings:
    """由组合根从环境变量解析后传入的运行值。"""

    text_to_image_url: str
    """文生图的完整地址。**连路径一起来自环境变量**，仓里不留对方的接口路由——
    公开仓不该说清我们在调谁的哪个内部接口。"""

    image_edit_url: str
    """图像编辑（带参考图）的完整地址，同上。"""

    user_name: str
    """对方要求的稳定调用方标识，用于它那边对账。"""


class NanoBananaImageProvider:
    """``GenerationProvider`` 的图像实现。"""

    def __init__(
        self,
        settings: NanoBananaSettings,
        *,
        object_store: PublicObjectStore,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """``transport`` 只给测试注入替身用。"""

        self._settings = settings
        self._user_name = settings.user_name
        self._object_store = object_store
        self._transport = transport

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = job.request
        if not isinstance(request, ImageGenerationIn):
            raise ProviderError(
                f"图像 provider 收到了 {job.kind} 请求",
                code="PROVIDER_KIND_MISMATCH",
                retryable=False,
            )
        body = await self._generate(job, request)
        source_url = _output_url(body)
        content, mime = await self._download(source_url)
        suffix = _SUFFIX_BY_MIME[mime]
        try:
            output_url = await self._object_store.put_public_object(
                object_key=f"{_OBJECT_KEY_PREFIX}/{job.id}.{suffix}",
                content=content,
                content_type=mime,
            )
        except ObjectStoreUnavailable as exc:
            # 图已经生成、也已经付了钱，只是没存下来。说成可重试是错的：重试会
            # 重新走一遍生成，再付一次。
            raise ProviderError(
                f"图像已生成但转存失败: {exc}",
                code="OUTPUT_STORE_FAILED",
                retryable=False,
            ) from exc
        return ProviderSubmission(
            # 这家没有任务 id，我们发过去的 data_id 就是它认得我们的那个键，
            # 对账时用它。
            provider_task_id=str(job.id),
            provider_status="succeeded",
            raw={"channel": request.channel, "sourceUrl": source_url, "response": body},
            output_url=output_url,
        )

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        raise ProviderError(
            "图像生成是同步的，没有轮询阶段",
            code="PROVIDER_POLL_UNSUPPORTED",
            retryable=False,
        )

    async def _generate(self, job: GenerationJob, request: ImageGenerationIn) -> dict[str, Any]:
        """发起一次生成。参考图为空走文生图接口，否则走图像编辑接口。"""

        references = list(request.reference_image_urls)
        url = self._settings.image_edit_url if references else self._settings.text_to_image_url
        payload: dict[str, Any] = {
            "data_id": str(job.id),
            "user_name": self._user_name,
            "prompt": request.prompt,
            "task_source": _TASK_SOURCE,
            "aspect_ratio": request.aspect_ratio,
            "resolution": request.resolution,
            "channel": request.channel,
        }
        if references:
            payload["input_str_list"] = references
        return await self._post(url, payload)

    async def _post(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        """发一次生成请求。

        异常按「送到了没有」分两类。这个区分不再驱动任何自动重试——它是给人看的：
        连都没连上说明这次没产生生成，可以放心重发；读超时、连接被中途掐断则可能已
        经在算、已经计费，重发之前得先跟对方核对。
        """

        try:
            async with httpx.AsyncClient(
                timeout=_GENERATE_TIMEOUT_SECONDS, transport=self._transport
            ) as client:
                response = await client.post(url, json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise ProviderError(
                f"图像 provider 连不上: {exc}",
                code="PROVIDER_UNREACHABLE",
                retryable=True,
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"图像生成请求已发出但没拿到结果，不重试以免重复计费: {exc}",
                code="PROVIDER_RESULT_UNKNOWN",
                retryable=False,
            ) from exc
        if response.status_code >= 500:
            raise ProviderError(
                f"图像 provider 返回 {response.status_code}",
                code="PROVIDER_SERVER_ERROR",
                retryable=True,
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"图像 provider 拒绝了这次请求（{response.status_code}）: {response.text[:500]}",
                code="PROVIDER_REJECTED",
                retryable=False,
            )
        try:
            body = response.json()
        except ValueError as exc:
            raise ProviderError(
                "图像 provider 的响应不是 JSON",
                code="PROVIDER_MALFORMED",
                retryable=False,
            ) from exc
        if not isinstance(body, dict):
            raise ProviderError(
                "图像 provider 的响应根不是 object",
                code="PROVIDER_MALFORMED",
                retryable=False,
            )
        return body

    async def _download(self, url: str) -> tuple[bytes, str]:
        """把结果图下载下来，返回字节与归一化后的 MIME。

        流式读并且带上限：结果图的大小由对方决定，整份读进内存之前得先有个天花板。
        """

        try:
            async with (
                httpx.AsyncClient(
                    timeout=_DOWNLOAD_TIMEOUT_SECONDS, transport=self._transport
                ) as client,
                client.stream("GET", url) as response,
            ):
                if response.status_code >= 400:
                    raise ProviderError(
                        f"结果图下载失败（{response.status_code}）",
                        code="OUTPUT_DOWNLOAD_FAILED",
                        retryable=False,
                    )
                mime = _normalize_mime(response.headers.get("content-type", ""), url)
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > _MAX_IMAGE_BYTES:
                        raise ProviderError(
                            f"结果图超过 {_MAX_IMAGE_BYTES} 字节上限",
                            code="OUTPUT_TOO_LARGE",
                            retryable=False,
                        )
                    chunks.append(chunk)
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"结果图下载失败: {exc}",
                code="OUTPUT_DOWNLOAD_FAILED",
                retryable=False,
            ) from exc
        content = b"".join(chunks)
        if not content:
            raise ProviderError(
                "结果图下载为空",
                code="OUTPUT_DOWNLOAD_EMPTY",
                retryable=False,
            )
        return content, mime


def _output_url(body: dict[str, Any]) -> str:
    """从响应里取可下载的结果 URL；优先签名地址。"""

    if body.get("success") is False:
        message = body.get("message")
        detail = message.strip() if isinstance(message, str) and message.strip() else "无说明"
        raise ProviderError(
            f"图像 provider 报告生成失败: {detail}",
            code="PROVIDER_GENERATION_FAILED",
            retryable=False,
        )
    for key in ("output_sign_str", "output_str"):
        value = body.get(key)
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            return value
    raise ProviderError(
        "图像 provider 的响应里没有结果 URL",
        code="PROVIDER_OUTPUT_MISSING",
        retryable=False,
    )


def _normalize_mime(content_type: str, url: str) -> str:
    """按响应头定 MIME，其次看 URL 后缀，都认不出就当 PNG。

    这个值会写进对象的 Content-Type，浏览器按它决定是显示还是下载，所以只允许落在
    我们支持的那几种上，不把对方给的任意字符串原样传下去。
    """

    mime = content_type.split(";", maxsplit=1)[0].strip().lower()
    if mime in _SUFFIX_BY_MIME:
        return mime
    path = urlsplit(url).path.lower()
    for suffix, known in _MIME_BY_SUFFIX.items():
        if path.endswith(f".{suffix}"):
            return known
    return _DEFAULT_MIME


__all__ = ["PROVIDER_NAME", "NanoBananaImageProvider", "NanoBananaSettings"]
