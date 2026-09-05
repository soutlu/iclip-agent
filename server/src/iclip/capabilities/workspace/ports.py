"""图片元信息查询协议，由组合根提供实现，供工作区选择原图、缩略图或裁切交付。"""

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
    """图片信息查询失败。"""


class MediaProbe(Protocol):
    """图片元信息查询协议。"""

    async def image_info(self, url: str) -> ImageInfo:
        """查询图片元信息；不可达、非图片或响应无效时抛 MediaProbeFailed。"""
        ...


__all__ = ["ImageInfo", "MediaProbe", "MediaProbeFailed"]
