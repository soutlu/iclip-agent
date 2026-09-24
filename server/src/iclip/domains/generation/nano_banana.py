"""Nano Banana Pro 在网关上与别家不同的部分：画幅与分辨率原样发，另有两个价钱不同的渠道。

提交、读结果地址与转存由 image_upstream.py 的网关 provider 统一处理。"""

from __future__ import annotations

from typing import Any, Final, get_args

from iclip.domains.generation.image_upstream import GatewayImageModel
from iclip.domains.generation.provider import ImageModelSpec, ProviderError
from iclip.domains.generation.schemas import (
    IMAGE_ASPECT_RATIOS,
    IMAGE_RESOLUTIONS,
    ImageGenerationIn,
)

_NAME: Final = "nano_banana_pro"


def _fields(request: ImageGenerationIn) -> dict[str, Any]:
    """画幅、分辨率与渠道原样发给上游。"""

    if request.channel is None:
        # 这家声明了渠道轴，受理层会填好；为空说明装配串了，不给付费接口送 null。
        raise ProviderError(
            f"{_NAME} 的请求没有渠道",
            code="PROVIDER_CHANNEL_MISSING",
            retryable=False,
        )
    return {
        "aspect_ratio": request.aspect_ratio,
        "resolution": request.resolution,
        "channel": request.channel,
    }


NANO_BANANA_PRO: Final = GatewayImageModel(
    name=_NAME,
    spec=ImageModelSpec(
        label="Nano Banana Pro",
        # 上游接受全部十档画幅与三档分辨率，与本仓的全局枚举一致。
        aspect_ratios=get_args(IMAGE_ASPECT_RATIOS),
        resolutions=get_args(IMAGE_RESOLUTIONS),
        # dev 先打 developer 模型、失败兜底非 developer；pro 只打非 developer。两档价钱不同。
        channels=("dev", "pro"),
    ),
    timeout_seconds=300.0,
    fields=_fields,
    # 快照记下实际走的渠道：两档价钱不同。
    snapshot_keys=("channel",),
)


__all__ = ["NANO_BANANA_PRO"]
