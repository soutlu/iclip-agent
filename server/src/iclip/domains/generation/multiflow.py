"""视频生成 provider（Multiflow）。

协议是两段式的：
  POST {submit_url}                     X-API-Key: …  → {"task_id": "…"}
  GET  {status_base_url}/{task_id}?user_name=…         → {"status": …, "result": {…}}

状态字符串原样存进 job 行，这里只把它归成三类去处（还在跑 / 成了 / 废了）。
**没见过的状态一律报错**，不当成「还在跑」——那等于对方新加了一个终态而我们一直
轮询下去，一个已经结束的任务永远不会收尾。

对方给的是会过期的地址，所以出结果之后下载下来转存成我们自己的公开对象，库里存那个不会
烂的地址（同图片那条路）。
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Final
from urllib.parse import quote, urlsplit

import httpx

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
)
from iclip.domains.generation.schemas import VideoGenerationIn
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.oss import ObjectStoreUnavailable, PublicObjectStore

PROVIDER_NAME: Final = "multiflow"

_RUNNING_STATUSES: Final = frozenset({"queued", "pending", "running", "processing"})
_SUCCEEDED_STATUS: Final = "succeeded"
_FAILED_STATUSES: Final = frozenset({"failed", "cancelled", "canceled", "error", "timeout"})

_SUBMIT_TIMEOUT_SECONDS: Final = 30.0
_POLL_TIMEOUT_SECONDS: Final = 20.0

_DOWNLOAD_TIMEOUT_SECONDS: Final = 600.0
"""下载成片的超时。一条几十兆的片子在内网也要走上几分钟，默认那 5 秒必定拿不完。"""

_MAX_VIDEO_BYTES: Final = 512 * 1024 * 1024
"""成片的字节上限，与素材登记那一侧的视频上限同一个尺子。"""

_MIME_BY_SUFFIX: Final = {"mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm"}
_SUFFIX_BY_MIME: Final = {"video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm"}
_DEFAULT_MIME: Final = "video/mp4"


@dataclass(frozen=True, slots=True)
class MultiflowSettings:
    """由组合根从环境变量解析后传入的运行值。"""

    submit_url: str
    status_base_url: str
    api_key: str
    model: str
    """默认模型。请求里给了 ``model`` 就用请求的。"""
    user_name: str
    """对方要求的稳定调用方标识，用于它那边对账。"""


class MultiflowVideoProvider:
    """``GenerationProvider`` 的视频实现。"""

    def __init__(
        self,
        settings: MultiflowSettings,
        *,
        object_store: PublicObjectStore,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """``transport`` 只给测试注入替身用（同 identity 的 SSO/PMS 客户端）。"""

        self._settings = settings
        self._object_store = object_store
        self._transport = transport

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = job.request
        if not isinstance(request, VideoGenerationIn):
            raise ProviderError(
                f"视频 provider 收到了 {job.kind} 请求",
                code="PROVIDER_KIND_MISMATCH",
                retryable=False,
            )
        model = request.model or self._settings.model
        payload = {
            "model": model,
            "prompt": request.prompt,
            "user_name": self._settings.user_name,
            "image_urls": list(request.image_urls),
            "reference_videos": list(request.reference_video_urls),
            "reference_audios": list(request.reference_audio_urls),
            "aspect_ratio": request.aspect_ratio,
            "seconds": request.duration_seconds,
        }
        body = await self._request(
            "POST",
            self._settings.submit_url,
            json=payload,
            timeout=_SUBMIT_TIMEOUT_SECONDS,
        )
        task_id = body.get("task_id")
        if not isinstance(task_id, str) or not task_id.strip():
            raise ProviderError(
                "视频提交响应里没有 task_id",
                code="PROVIDER_SUBMIT_MALFORMED",
                retryable=False,
            )
        return ProviderSubmission(
            provider_task_id=task_id.strip(),
            provider_status="queued",
            # 记下实际发出去的是哪个模型：默认值在配置里，将来配置改了，
            # 旧的那些行还得说得清当时用的是什么。
            raw={"model": model, "response": body},
        )

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        task_id = job.provider_task_id
        if task_id is None:
            raise ProviderError(
                "还没有 provider 任务 id，无从查询",
                code="PROVIDER_TASK_ID_MISSING",
                retryable=False,
            )
        url = f"{self._settings.status_base_url.rstrip('/')}/{quote(task_id, safe='')}"
        body = await self._request(
            "GET",
            url,
            params={"user_name": self._settings.user_name},
            timeout=_POLL_TIMEOUT_SECONDS,
        )
        progress = _progress_from_body(body)
        if progress.outcome != "succeeded" or progress.output_url is None:
            return progress
        return replace(progress, output_url=await self._rehost(job, progress.output_url))

    async def _rehost(self, job: GenerationJob, source_url: str) -> str:
        """把成片搬进我们自己的公开对象，返回那个地址。

        对方给的地址会过期，存进库里迟早烂掉。搬不动时**不留下 provider 的地址**：那样
        这一行看着是成功的，过几天点开却是坏的。
        """

        content, mime = await self._download(source_url)
        try:
            return await self._object_store.put_public_object(
                object_key=MEDIA_PATHS.generated_video(job_id=job.id, ext=_SUFFIX_BY_MIME[mime]),
                content=content,
                content_type=mime,
            )
        except ObjectStoreUnavailable as exc:
            # 片子已经出了、也已经付了钱。说成可重试是错的：那会重新走一遍生成，再付一次。
            raise ProviderError(
                f"视频已生成但转存失败: {exc}",
                code="OUTPUT_STORE_FAILED",
                retryable=False,
            ) from exc

    async def _download(self, url: str) -> tuple[bytes, str]:
        """把成片下载下来，返回字节与归一化后的 MIME。

        流式读并且带上限：一条片子几十兆是常态，整份读进内存之前得先有个天花板。
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
                        f"成片下载失败（{response.status_code}）",
                        code="OUTPUT_DOWNLOAD_FAILED",
                        retryable=False,
                    )
                mime = _normalize_mime(response.headers.get("content-type", ""), url)
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > _MAX_VIDEO_BYTES:
                        raise ProviderError(
                            f"成片超过 {_MAX_VIDEO_BYTES} 字节上限",
                            code="OUTPUT_TOO_LARGE",
                            retryable=False,
                        )
                    chunks.append(chunk)
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"成片下载失败: {exc}",
                code="OUTPUT_DOWNLOAD_FAILED",
                retryable=False,
            ) from exc
        content = b"".join(chunks)
        if not content:
            raise ProviderError(
                "成片下载为空",
                code="OUTPUT_DOWNLOAD_EMPTY",
                retryable=False,
            )
        return content, mime

    async def _request(
        self,
        method: str,
        url: str,
        *,
        timeout: float,
        json: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """发一次请求并要求响应是 JSON object。

        网络故障与 5xx 归成可重试，4xx 归成不可重试：对方明确说这个请求不行，
        原样再发一遍只会得到同样的答案。
        """

        try:
            async with httpx.AsyncClient(timeout=timeout, transport=self._transport) as client:
                response = await client.request(
                    method,
                    url,
                    json=json,
                    params=params,
                    headers={"X-API-Key": self._settings.api_key},
                )
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"视频 provider 不可达: {exc}",
                code="PROVIDER_UNREACHABLE",
                retryable=True,
            ) from exc
        if response.status_code >= 500:
            raise ProviderError(
                f"视频 provider 返回 {response.status_code}",
                code="PROVIDER_SERVER_ERROR",
                retryable=True,
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"视频 provider 拒绝了这次请求（{response.status_code}）: {response.text[:500]}",
                code="PROVIDER_REJECTED",
                retryable=False,
            )
        try:
            body = response.json()
        except ValueError as exc:
            raise ProviderError(
                "视频 provider 的响应不是 JSON",
                code="PROVIDER_MALFORMED",
                retryable=True,
            ) from exc
        if not isinstance(body, dict):
            raise ProviderError(
                "视频 provider 的响应根不是 object",
                code="PROVIDER_MALFORMED",
                retryable=True,
            )
        return body


def _progress_from_body(body: dict[str, Any]) -> ProviderProgress:
    status_value = body.get("status")
    if not isinstance(status_value, str) or not status_value.strip():
        raise ProviderError(
            "视频状态响应里没有 status",
            code="PROVIDER_MALFORMED",
            retryable=True,
        )
    status = status_value.strip().lower()

    if status == _SUCCEEDED_STATUS:
        result = body.get("result")
        output_url = result.get("output_url") if isinstance(result, dict) else None
        if not isinstance(output_url, str) or not output_url.startswith(("http://", "https://")):
            # 说成功却没给结果，这是协议破了，不是「还在跑」。
            raise ProviderError(
                "视频 provider 报成功但没给 result.output_url",
                code="PROVIDER_OUTPUT_MISSING",
                retryable=False,
            )
        return ProviderProgress(
            outcome="succeeded",
            provider_status=status,
            raw=body,
            output_url=output_url,
        )

    if status in _FAILED_STATUSES:
        code, message = _error_fields(body.get("error"))
        return ProviderProgress(
            outcome="failed",
            provider_status=status,
            raw=body,
            error_code=code or f"PROVIDER_{status.upper()}",
            error_message=message or f"provider 状态为 {status}",
        )

    if status in _RUNNING_STATUSES:
        return ProviderProgress(outcome="running", provider_status=status, raw=body)

    raise ProviderError(
        f"没见过的视频生成状态: {status}",
        code="PROVIDER_STATUS_UNKNOWN",
        retryable=False,
    )


def _normalize_mime(content_type: str, url: str) -> str:
    """按响应头定 MIME，其次看 URL 后缀，都认不出就当 mp4。

    这个值会写进对象的 Content-Type，浏览器按它决定播还是下载，所以只允许落在我们支持
    的那几种上，不把对方给的任意字符串原样传下去。
    """

    mime = content_type.split(";", maxsplit=1)[0].strip().lower()
    if mime in _SUFFIX_BY_MIME:
        return mime
    path = urlsplit(url).path.lower()
    for suffix, known in _MIME_BY_SUFFIX.items():
        if path.endswith(f".{suffix}"):
            return known
    return _DEFAULT_MIME


def _error_fields(error: Any) -> tuple[str | None, str | None]:
    """对方的 error 字段有时是字符串，有时是 ``{code, message}``。"""

    if isinstance(error, str) and error.strip():
        return None, error.strip()
    if isinstance(error, dict):
        code = error.get("code")
        message = error.get("message")
        return (
            code.strip() if isinstance(code, str) and code.strip() else None,
            message.strip() if isinstance(message, str) and message.strip() else None,
        )
    return None, None


__all__ = ["PROVIDER_NAME", "MultiflowSettings", "MultiflowVideoProvider"]
