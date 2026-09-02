"""工作区向外要的东西：只有「问一张图的原始信息」这一口。

读图要先知道原图多大、多重、是什么格式，才决定这次交付原图、缩略档还是一块裁切。
这件事只有对象存储答得上，所以在这里声明成一个窄协议，实现留给组合根。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class ImageInfo:
    """一张图的原始信息。"""

    media_type: str
    """形如 ``image/jpeg``。"""

    size_bytes: int
    width: int
    height: int


class MediaProbeFailed(Exception):
    """问不出这张图的信息。"""


class MediaProbe(Protocol):
    """问图片原始信息的那一口。"""

    async def image_info(self, url: str) -> ImageInfo:
        """问一张图的原始信息。

        地址不可达、不是图、或对方返回的信息读不出来，抛 ``MediaProbeFailed``。
        """
        ...


__all__ = ["ImageInfo", "MediaProbe", "MediaProbeFailed"]
