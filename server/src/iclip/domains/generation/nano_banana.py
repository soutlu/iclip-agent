"""同步图像生成适配器。无参考图调用文生图接口，有参考图调用编辑接口；不支持轮询。

完整接口地址由环境变量提供。临时结果必须转存为本系统公开对象后才能标记成功。
生成接口没有幂等键，不自动重试或切换渠道，避免重复计费或改变调用方选择的价格。
错误码区分连接失败与结果未知，供调用方判断是否重新提交。"""

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
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.oss import ObjectStoreUnavailable, PublicObjectStore

PROVIDER_NAME: Final = "nano_banana_pro"

_TASK_SOURCE: Final = "iClip"

_GENERATE_TIMEOUT_SECONDS: Final = 300.0
_DOWNLOAD_TIMEOUT_SECONDS: Final = 60.0
_MAX_IMAGE_BYTES: Final = 64 * 1024 * 1024

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
    """包含路径的文生图地址，由环境变量提供。"""

    image_edit_url: str
    """包含路径的图像编辑地址，由环境变量提供。"""

    user_name: str
    """Provider 要求的稳定调用方标识，用于对账。"""


class NanoBananaImageProvider:
    """``GenerationProvider`` 的图像实现。"""

    def __init__(
        self,
        settings: NanoBananaSettings,
        *,
        object_store: PublicObjectStore,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:

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
                object_key=MEDIA_PATHS.generated_image(job_id=job.id, ext=suffix),
                content=content,
                content_type=mime,
            )
        except ObjectStoreUnavailable as exc:
            # 生成已计费，转存失败不得触发重新生成。
            raise ProviderError(
                f"图像已生成但转存失败: {exc}",
                code="OUTPUT_STORE_FAILED",
                retryable=False,
            ) from exc
        return ProviderSubmission(
            # Provider 不返回任务 id，使用请求 data_id 对账。
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
        """提交一次生成；连接失败与请求结果未知使用不同错误码，不触发自动重试。"""

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
        """流式下载结果图并限制总字节数，返回内容与标准 MIME 类型。"""

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
    """从响应头或 URL 后缀选择支持的 MIME 类型，无法识别时使用 PNG。"""

    mime = content_type.split(";", maxsplit=1)[0].strip().lower()
    if mime in _SUFFIX_BY_MIME:
        return mime
    path = urlsplit(url).path.lower()
    for suffix, known in _MIME_BY_SUFFIX.items():
        if path.endswith(f".{suffix}"):
            return known
    return _DEFAULT_MIME


__all__ = ["PROVIDER_NAME", "NanoBananaImageProvider", "NanoBananaSettings"]
