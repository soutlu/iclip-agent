"""网关图片 provider：各家图片模型挂在同一个网关上，同步出图后把结果转存成自家公开对象。

提交、读结果地址、转存三段各家一模一样，错误码与是否可重试的判定只在这里定一次；每家只在
``GatewayImageModel`` 里给出名字、能力声明、超时和它专有的那几个 payload 键。无参考图打文生图，
有参考图打图像编辑；不支持轮询。生成接口没有幂等键，不自动重试或切换渠道，避免重复计费或
改变调用方选择的价格。"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import urlsplit

import httpx

from iclip.common.urls import is_http_url
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ImageModelSpec,
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
    request_of,
    user_name_of,
)
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.platform.media.ffmpeg import MAX_IMAGE_BYTES
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable, PublicObjectStore

_DOWNLOAD_TIMEOUT_SECONDS: Final = 60.0

TASK_SOURCE: Final = "iclip_agent"
"""网关按它认调用方，取值须在它的来源白名单里。"""

_TASK_TEXT_TO_IMAGE: Final = "text-to-image_ixiaomei"
_TASK_IMAGE_EDIT: Final = "image-edit_ixiaomei"

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

ImageFields = Callable[[ImageGenerationIn], dict[str, Any]]
"""把领域请求翻成这家专有的 payload 键；翻不了（受理层本该拦下）就抛 ``ProviderError``。"""


@dataclass(frozen=True, slots=True)
class GatewayImageModel:
    """一家网关图片模型与别家不同的全部东西。"""

    name: str
    """落库的 provider 名，也是它那条队列的名字。"""

    spec: ImageModelSpec

    timeout_seconds: float
    """一次同步出图最多等多久。"""

    fields: ImageFields

    snapshot_keys: tuple[str, ...]
    """专有键里要记进 provider 快照的那几个。"""


@dataclass(frozen=True, slots=True)
class GatewayImageSettings:
    """由组合根从环境变量与运行配置拼好后传入的运行值。"""

    api_base: str
    """这家在网关上的地址，两条任务路由拼在它后面。"""

    env: str
    """网关要求的调用环境。它按 task_source 与这一项一起判这次调用合不合法。"""


class GatewayImageProvider:
    """``GenerationProvider`` 的网关图片实现，一家模型一个实例。"""

    def __init__(
        self,
        model: GatewayImageModel,
        settings: GatewayImageSettings,
        *,
        object_store: PublicObjectStore,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:

        self._model = model
        self._settings = settings
        self._object_store = object_store
        self._transport = transport

    @property
    def name(self) -> str:
        return self._model.name

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = request_of(job, ImageGenerationIn, provider=self.name)
        fields = self._model.fields(request)
        references = list(request.reference_image_urls)
        payload: dict[str, Any] = {
            "data_id": str(job.id),
            "user_name": user_name_of(request),
            "prompt": request.prompt,
            "task_source": TASK_SOURCE,
            "env": self._settings.env,
            **fields,
        }
        if references:
            payload["input_str_list"] = references
        body = await _post_generation(
            task_url(self._settings.api_base, editing=bool(references)),
            payload,
            timeout=self._model.timeout_seconds,
            transport=self._transport,
        )
        source_url = _read_output_url(body)
        output_url = await _store_result(
            job_id=job.id,
            source_url=source_url,
            object_store=self._object_store,
            transport=self._transport,
        )
        return ProviderSubmission(
            # 网关不返回任务 id，使用请求 data_id 对账。
            provider_task_id=str(job.id),
            provider_status="succeeded",
            raw={
                **{key: fields[key] for key in self._model.snapshot_keys},
                "sourceUrl": source_url,
                "response": body,
            },
            output_url=output_url,
        )

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        raise ProviderError(
            "图像生成是同步的，没有轮询阶段",
            code="PROVIDER_POLL_UNSUPPORTED",
            retryable=False,
        )


def task_url(api_base: str, *, editing: bool) -> str:
    """拼出这次要打的地址。每个模型在网关上都是两条路由：文生图与图像编辑各一条。"""

    task = _TASK_IMAGE_EDIT if editing else _TASK_TEXT_TO_IMAGE
    return f"{api_base.rstrip('/')}/{task}"


async def _post_generation(
    url: str,
    payload: dict[str, Any],
    *,
    timeout: float,
    transport: httpx.AsyncBaseTransport | None,
) -> dict[str, Any]:
    """提交一次生成；连接失败与请求结果未知使用不同错误码，不触发自动重试。"""

    try:
        async with httpx.AsyncClient(timeout=timeout, transport=transport) as client:
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


def _read_output_url(body: dict[str, Any]) -> str:
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
        if isinstance(value, str) and is_http_url(value):
            return value
    raise ProviderError(
        "图像 provider 的响应里没有结果 URL",
        code="PROVIDER_OUTPUT_MISSING",
        retryable=False,
    )


async def _store_result(
    *,
    job_id: uuid.UUID,
    source_url: str,
    object_store: PublicObjectStore,
    transport: httpx.AsyncBaseTransport | None,
) -> str:
    """下载结果图并转存成本系统的公开对象，返回永久地址。"""

    content, mime = await _download(source_url, transport=transport)
    try:
        return await object_store.put_public_object(
            object_key=MEDIA_PATHS.generated_image(job_id=job_id, ext=_SUFFIX_BY_MIME[mime]),
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


async def _download(url: str, *, transport: httpx.AsyncBaseTransport | None) -> tuple[bytes, str]:
    """流式下载结果图并限制总字节数，返回内容与标准 MIME 类型。"""

    try:
        async with (
            httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT_SECONDS, transport=transport) as client,
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
                if size > MAX_IMAGE_BYTES:
                    raise ProviderError(
                        f"结果图超过 {MAX_IMAGE_BYTES} 字节上限",
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


__all__ = [
    "TASK_SOURCE",
    "GatewayImageModel",
    "GatewayImageProvider",
    "GatewayImageSettings",
    "ImageFields",
    "task_url",
]
