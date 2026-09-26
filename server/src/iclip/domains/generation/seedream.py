"""Seedream 5.0 Pro 在网关上与别家不同的部分：只收一个同时表达画幅与分辨率的像素 ``size``。

所以这里带一张画幅×档位的映射表，能力声明由这张表的键推导，不手写第二份。它没有渠道这个轴。
上游路由拼写沿用它公开契约里的 ``seedrance``，落库的 provider 名用 ``seedream_v5_pro``。
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

_NAME: Final = "seedream_v5_pro"

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


_OUTPUT_FORMAT: Final = "jpeg"


def _fields(request: ImageGenerationIn) -> dict[str, Any]:
    """把画幅与档位翻成上游的像素 size。"""

    size = _SIZES.get((request.aspect_ratio, request.resolution))
    if size is None:
        # 受理层照能力声明拦过，走到这里说明声明与映射表不一致。
        raise ProviderError(
            f"{_NAME} 没有 {request.aspect_ratio} × {request.resolution} 的尺寸",
            code="PROVIDER_SIZE_UNSUPPORTED",
            retryable=False,
        )
    return {"size": size, "output_format": _OUTPUT_FORMAT}


SEEDREAM_V5_PRO: Final = GatewayImageModel(
    name=_NAME,
    spec=ImageModelSpec(
        label="Seedream 5.0 Pro",
        aspect_ratios=_declared(get_args(IMAGE_ASPECT_RATIOS), 0),
        resolutions=_declared(get_args(IMAGE_RESOLUTIONS), 1),
        # 这家没有渠道这个轴，payload 里也不出现。
        channels=(),
    ),
    # 比 nano 长一倍：出图更慢，而它自己一条队列，占着不影响别家。
    timeout_seconds=600.0,
    fields=_fields,
)


__all__ = ["SEEDREAM_V5_PRO"]
