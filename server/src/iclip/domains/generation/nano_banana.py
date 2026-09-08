"""同步图像生成适配器。无参考图调用文生图接口，有参考图调用编辑接口；不支持轮询。

完整接口地址由环境变量提供。提交、读结果地址与转存三段是各家图像 provider 共用的，
在 image_upstream.py；这里只剩这家自己的地址、payload 与超时。
生成接口没有幂等键，不自动重试或切换渠道，避免重复计费或改变调用方选择的价格。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

import httpx

from iclip.domains.generation.image_upstream import (
    post_generation,
    read_output_url,
    store_result,
)
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
)
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.platform.object_store.oss import PublicObjectStore

PROVIDER_NAME: Final = "nano_banana_pro"

_TASK_SOURCE: Final = "iClip"

_GENERATE_TIMEOUT_SECONDS: Final = 300.0


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
        url, payload = self._call(job, request)
        body = await post_generation(
            url, payload, timeout=_GENERATE_TIMEOUT_SECONDS, transport=self._transport
        )
        source_url = read_output_url(body)
        output_url = await store_result(
            job_id=job.id,
            source_url=source_url,
            object_store=self._object_store,
            transport=self._transport,
        )
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

    def _call(self, job: GenerationJob, request: ImageGenerationIn) -> tuple[str, dict[str, Any]]:
        """这家自己的那一段：按有无参考图选端点，把领域请求拼成上游 payload。"""

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
        return url, payload


__all__ = ["PROVIDER_NAME", "NanoBananaImageProvider", "NanoBananaSettings"]
