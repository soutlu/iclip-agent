"""Seedream 5.0 Pro 的同步图像适配器。无参考图打文生图，有参考图打图像编辑。

上游只收一个同时表达画幅与分辨率的像素 ``size``，所以这里带一张画幅×档位的映射表；
能力声明由这张表的键推导，不手写第二份。它没有渠道这个轴。
上游路由拼写沿用它公开契约里的 ``seedrance``，落库的 provider 名用 ``seedream_v5_pro``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final, get_args

import httpx

from iclip.domains.generation.image_upstream import (
    TASK_SOURCE,
    post_generation,
    read_output_url,
    store_result,
    task_url,
    user_name_of,
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

PROVIDER_NAME: Final = "seedream_v5_pro"

_SIZES: Final[dict[tuple[str, str], str]] = {
    ("1:1", "1k"): "1024*1024",
    ("1:1", "2k"): "2048*2048",
    ("3:2", "1k"): "1248*832",
    ("3:2", "2k"): "2496*1664",
    ("2:3", "1k"): "832*1248",
    ("2:3", "2k"): "1664*2496",
    ("3:4", "1k"): "864*1152",
    ("3:4", "2k"): "1776*2368",
    ("4:3", "1k"): "1152*864",
    ("4:3", "2k"): "2368*1776",
    ("9:16", "1k"): "800*1424",
    ("9:16", "2k"): "1584*2816",
    ("16:9", "1k"): "1424*800",
    ("16:9", "2k"): "2816*1584",
    ("21:9", "1k"): "1568*672",
    ("21:9", "2k"): "3136*1344",
}
"""上游只认这些像素串。它还接受 9:21 与档位关键字，本仓两者都不用：全局画幅枚举里
没有 9:21，而关键字形态让模型自己猜比例，与「画幅由调用方指定」冲突。"""


def _declared[T](values: tuple[T, ...], index: int) -> tuple[T, ...]:
    """按全局枚举的顺序挑出映射表里出现过的那些档。"""

    present = {key[index] for key in _SIZES}
    return tuple(value for value in values if value in present)


SPEC: Final = ImageModelSpec(
    label="Seedream 5.0 Pro",
    aspect_ratios=_declared(get_args(IMAGE_ASPECT_RATIOS), 0),
    resolutions=_declared(get_args(IMAGE_RESOLUTIONS), 1),
    # 这家没有渠道这个轴，payload 里也不出现。
    channels=(),
)

_GENERATE_TIMEOUT_SECONDS: Final = 600.0
"""比 nano 长一倍：出图更慢，而它自己一条队列，占着不影响别家。"""

_OUTPUT_FORMAT: Final = "jpeg"


@dataclass(frozen=True, slots=True)
class SeedreamSettings:
    """由组合根从环境变量与运行配置拼好后传入的运行值。"""

    api_base: str
    """这家在网关上的地址，两条任务路由拼在它后面。"""

    env: str
    """网关要求的调用环境。它按 task_source 与这一项一起判这次调用合不合法。"""


class SeedreamImageProvider:
    """``GenerationProvider`` 的 Seedream 实现。"""

    def __init__(
        self,
        settings: SeedreamSettings,
        *,
        object_store: PublicObjectStore,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:

        self._settings = settings
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
            raw={"size": payload["size"], "sourceUrl": source_url, "response": body},
            output_url=output_url,
        )

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        raise ProviderError(
            "图像生成是同步的，没有轮询阶段",
            code="PROVIDER_POLL_UNSUPPORTED",
            retryable=False,
        )

    def _call(self, job: GenerationJob, request: ImageGenerationIn) -> tuple[str, dict[str, Any]]:
        """这家自己的那一段：按有无参考图选端点，把画幅与档位翻成上游的像素 size。"""

        size = _SIZES.get((request.aspect_ratio, request.resolution))
        if size is None:
            # 受理层照 SPEC 拦过，走到这里说明声明与映射表不一致。
            raise ProviderError(
                f"{PROVIDER_NAME} 没有 {request.aspect_ratio} × {request.resolution} 的尺寸",
                code="PROVIDER_SIZE_UNSUPPORTED",
                retryable=False,
            )
        references = list(request.reference_image_urls)
        payload: dict[str, Any] = {
            "data_id": str(job.id),
            "user_name": user_name_of(request),
            "prompt": request.prompt,
            "task_source": TASK_SOURCE,
            "env": self._settings.env,
            "size": size,
            "output_format": _OUTPUT_FORMAT,
        }
        if references:
            payload["input_str_list"] = references
        return task_url(self._settings.api_base, editing=bool(references)), payload


__all__ = ["PROVIDER_NAME", "SPEC", "SeedreamImageProvider", "SeedreamSettings"]
