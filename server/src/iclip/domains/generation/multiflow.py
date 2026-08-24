"""视频生成 provider（Multiflow）。

协议是两段式的：
  POST {submit_url}                     X-API-Key: …  → {"task_id": "…"}
  GET  {status_base_url}/{task_id}?user_name=…         → {"status": …, "result": {…}}

状态字符串原样存进 job 行，这里只把它归成三类去处（还在跑 / 成了 / 废了）。
**没见过的状态一律报错**，不当成「还在跑」——那等于对方新加了一个终态而我们一直
轮询下去，一个已经结束的任务永远不会收尾。
"""

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
from iclip.domains.generation.schemas import VideoGenerationIn

PROVIDER_NAME: Final = "multiflow"

_RUNNING_STATUSES: Final = frozenset({"queued", "pending", "running", "processing"})
_SUCCEEDED_STATUS: Final = "succeeded"
_FAILED_STATUSES: Final = frozenset({"failed", "cancelled", "canceled", "error", "timeout"})

_SUBMIT_TIMEOUT_SECONDS: Final = 30.0
_POLL_TIMEOUT_SECONDS: Final = 20.0


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
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """``transport`` 只给测试注入替身用（同 identity 的 SSO/PMS 客户端）。"""

        self._settings = settings
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
        return _progress_from_body(body)

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
