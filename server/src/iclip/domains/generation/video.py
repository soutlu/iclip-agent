"""视频异步接口的适配器。提交拿 task_id，之后按固定间隔查状态。

请求字段与上游一字不差，原样转发；成功时上游给的是它自己发布好的两个稳定地址（原片与
水印版），直接存，不再转存。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import quote

import httpx

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
)
from iclip.domains.generation.schemas import ORIGIN_FIELDS, VideoGenerationIn

PROVIDER_NAME: Final = "video_api"

_RUNNING_STATUSES: Final = frozenset({"queued", "pending", "running", "processing"})
_SUCCEEDED_STATUS: Final = "succeeded"
_FAILED_STATUSES: Final = frozenset({"failed", "cancelled", "canceled", "error", "timeout"})

_SUBMIT_TIMEOUT_SECONDS: Final = 30.0
_POLL_TIMEOUT_SECONDS: Final = 20.0


@dataclass(frozen=True, slots=True)
class VideoProviderSettings:
    """由组合根从环境变量解析后传入的运行值。模型与归属标签都在请求里，这里不持有。"""

    submit_url: str
    status_base_url: str
    api_key: str


class HttpVideoProvider:
    """``GenerationProvider`` 的视频实现。"""

    def __init__(
        self,
        settings: VideoProviderSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:

        self._settings = settings
        self._transport = transport

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = _video_request(job)
        _user_name(request)
        # 没给的可选字段不发，上游的模型默认值才能生效；归属字段是我们自己的，不发。
        payload = request.model_dump(exclude_none=True, exclude=set(ORIGIN_FIELDS))
        body = await self._request(
            "POST",
            self._settings.submit_url,
            json=payload,
            timeout=_SUBMIT_TIMEOUT_SECONDS,
            result_unknown_on_transport_error=True,
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
            raw={"response": body},
        )

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        request = _video_request(job)
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
            params={"user_name": _user_name(request)},
            timeout=_POLL_TIMEOUT_SECONDS,
        )
        return _progress_from_body(body)

    async def _request(
        self,
        method: str,
        url: str,
        *,
        timeout: float,
        json: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        result_unknown_on_transport_error: bool = False,
    ) -> dict[str, Any]:
        """请求 JSON 对象响应。

        连不上是 ``PROVIDER_UNREACHABLE``。连上了却没拿到结果（读超时之类）在提交阶段是
        ``PROVIDER_RESULT_UNKNOWN``：请求可能已被收下，不能当成没发出去；查状态是幂等的，
        仍按不可达处理。5xx 可重试，4xx 不可重试。
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
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise ProviderError(
                f"视频接口连不上: {exc}",
                code="PROVIDER_UNREACHABLE",
                retryable=True,
            ) from exc
        except httpx.HTTPError as exc:
            if result_unknown_on_transport_error:
                raise ProviderError(
                    f"视频提交请求已发出但没拿到结果，不重试以免重复计费: {exc}",
                    code="PROVIDER_RESULT_UNKNOWN",
                    retryable=False,
                ) from exc
            raise ProviderError(
                f"视频接口不可达: {exc}",
                code="PROVIDER_UNREACHABLE",
                retryable=True,
            ) from exc
        if response.status_code >= 500:
            raise ProviderError(
                f"视频接口返回 {response.status_code}",
                code="PROVIDER_SERVER_ERROR",
                retryable=True,
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"视频接口拒绝了这次请求（{response.status_code}）: {response.text[:500]}",
                code="PROVIDER_REJECTED",
                retryable=False,
            )
        try:
            body = response.json()
        except ValueError as exc:
            raise ProviderError(
                "视频接口的响应不是 JSON",
                code="PROVIDER_MALFORMED",
                retryable=True,
            ) from exc
        if not isinstance(body, dict):
            raise ProviderError(
                "视频接口的响应根不是 object",
                code="PROVIDER_MALFORMED",
                retryable=True,
            )
        return body


def _video_request(job: GenerationJob) -> VideoGenerationIn:
    request = job.request
    if not isinstance(request, VideoGenerationIn):
        raise ProviderError(
            f"视频 provider 收到了 {job.kind} 请求",
            code="PROVIDER_KIND_MISMATCH",
            retryable=False,
        )
    return request


def _user_name(request: VideoGenerationIn) -> str:
    """受理层保证填好了；为空说明装配串了，不给付费接口送一个没名字的请求。"""

    if request.user_name is None:
        raise ProviderError(
            "视频请求没有 user_name",
            code="PROVIDER_USER_NAME_MISSING",
            retryable=False,
        )
    return request.user_name


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
        urls = {
            key: (result.get(key) if isinstance(result, dict) else None)
            for key in ("output_url", "watermark_output_url")
        }
        missing = [
            key
            for key, value in urls.items()
            if not isinstance(value, str) or not value.startswith(("http://", "https://"))
        ]
        if missing:
            # 上游两份产物都发布完才进 succeeded，缺一份就是协议错。
            raise ProviderError(
                f"视频接口报成功但没给 result.{' / result.'.join(missing)}",
                code="PROVIDER_OUTPUT_MISSING",
                retryable=False,
            )
        return ProviderProgress(
            outcome="succeeded",
            provider_status=status,
            raw=body,
            output_url=str(urls["output_url"]),
            watermark_output_url=str(urls["watermark_output_url"]),
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


def _error_fields(error: Any) -> tuple[str | None, str | None]:
    """本地错误读 message；PROVIDER_ERROR 优先保留上游的 upstream_message 原文。"""

    if isinstance(error, str) and error.strip():
        return None, error.strip()
    if isinstance(error, dict):
        code = error.get("code")
        message = error.get("message")
        upstream_message = error.get("upstream_message")
        if (
            code == "PROVIDER_ERROR"
            and isinstance(upstream_message, str)
            and upstream_message.strip()
        ):
            message = upstream_message
        return (
            code.strip() if isinstance(code, str) and code.strip() else None,
            message.strip() if isinstance(message, str) and message.strip() else None,
        )
    return None, None


__all__ = ["PROVIDER_NAME", "HttpVideoProvider", "VideoProviderSettings"]
