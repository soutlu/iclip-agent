"""同步图像生成适配器。无参考图调用文生图接口，有参考图调用编辑接口；不支持轮询。

地址由组合根按「网关根地址 + 这家的路由段」拼好传进来。提交、读结果地址与转存三段是
各家图像 provider 共用的，在 image_upstream.py；这里只剩这家自己的 payload 与超时。
生成接口没有幂等键，不自动重试或切换渠道，避免重复计费或改变调用方选择的价格。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final, get_args

import httpx

from iclip.domains.generation.image_upstream import (
    post_generation,
    read_output_url,
    store_result,
    task_url,
)
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ImageModelSpec,
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
)
from iclip.domains.generation.schemas import (
    IMAGE_ASPECT_RATIOS,
    IMAGE_RESOLUTIONS,
    ImageGenerationIn,
)
from iclip.platform.object_store.oss import PublicObjectStore

PROVIDER_NAME: Final = "nano_banana_pro"

SPEC: Final = ImageModelSpec(
    label="Nano Banana Pro",
    # 上游接受全部十档画幅与三档分辨率，与本仓的全局枚举一致。
    aspect_ratios=get_args(IMAGE_ASPECT_RATIOS),
    resolutions=get_args(IMAGE_RESOLUTIONS),
    # dev 先打 developer 模型、失败兜底非 developer；pro 只打非 developer。两档价钱不同。
    channels=("dev", "pro"),
)

_TASK_SOURCE: Final = "iClip"

_GENERATE_TIMEOUT_SECONDS: Final = 300.0


@dataclass(frozen=True, slots=True)
class NanoBananaSettings:
    """由组合根从环境变量解析后传入的运行值。"""

    api_base: str
    """这家在网关上的地址，两条任务路由拼在它后面。"""

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
        url = task_url(self._settings.api_base, editing=bool(references))
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


__all__ = ["PROVIDER_NAME", "SPEC", "NanoBananaImageProvider", "NanoBananaSettings"]
