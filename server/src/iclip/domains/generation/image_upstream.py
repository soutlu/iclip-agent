"""图像 provider 共用的三段：提交一次生成、读出结果地址、把结果转存成自家公开对象。

各家图像 provider 之间只有「打哪个地址、payload 怎么拼」不一样，这三段一模一样，
所以错误码与是否可重试的判定也只在这里定一次。"""

from __future__ import annotations

import uuid
from typing import Any, Final
from urllib.parse import urlsplit

import httpx

from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.oss import ObjectStoreUnavailable, PublicObjectStore

_DOWNLOAD_TIMEOUT_SECONDS: Final = 60.0
_MAX_IMAGE_BYTES: Final = 64 * 1024 * 1024

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


def task_url(api_base: str, *, editing: bool) -> str:
    """拼出这次要打的地址。每个模型在网关上都是两条路由：文生图与图像编辑各一条。"""

    task = _TASK_IMAGE_EDIT if editing else _TASK_TEXT_TO_IMAGE
    return f"{api_base.rstrip('/')}/{task}"


def user_name_of(request: ImageGenerationIn) -> str:
    """网关按它落表对账。受理层保证填好了；为空说明装配串了，不给付费接口送一个没名字的请求。"""

    if request.user_name is None:
        raise ProviderError(
            "图像请求没有 user_name",
            code="PROVIDER_USER_NAME_MISSING",
            retryable=False,
        )
    return request.user_name


async def post_generation(
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


def read_output_url(body: dict[str, Any]) -> str:
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


async def store_result(
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
    "post_generation",
    "read_output_url",
    "store_result",
    "task_url",
    "user_name_of",
]
