"""上传的类型与尺寸限制。上传不登记：确认后只交回桶里那个对象的公开地址。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

MediaKind = Literal["image", "video"]

UPLOAD_TYPES: Final[Mapping[str, tuple[MediaKind, str]]] = {
    "image/jpeg": ("image", "jpg"),
    "image/png": ("image", "png"),
    "image/webp": ("image", "webp"),
    "video/mp4": ("video", "mp4"),
    "video/quicktime": ("video", "mov"),
}
"""MIME 类型、媒体种类与扩展名统一维护，确保支持的类型都有对应的对象后缀。"""

MAX_BYTES: Final[Mapping[MediaKind, int]] = {
    "image": 16 * 1024 * 1024,
    "video": 512 * 1024 * 1024,
}
"""确认时校验大小上限；预签名 PUT 不限制上传长度，超限对象不交回地址。"""

MIN_SHORT_EDGE_PIXELS: Final = 300
MAX_LONG_EDGE_PIXELS: Final = 6000
"""图片尺寸限制，不适用于视频分辨率。"""


@dataclass(frozen=True, slots=True)
class UploadTicket:
    """无持久状态的直传凭证；确认时的对象位置由 upload_id 推导。"""

    upload_id: uuid.UUID
    upload_url: str
    headers: Mapping[str, str]
    """签进了签名里的请求头：Content-Type 与审计用的 x-oss-meta-*，浏览器必须原样带上。"""
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class ConfirmedUpload:
    """确认后交回的事实，全部从桶里读来。"""

    url: str
    content_type: str
    size_bytes: int


__all__ = [
    "MAX_BYTES",
    "MAX_LONG_EDGE_PIXELS",
    "MIN_SHORT_EDGE_PIXELS",
    "UPLOAD_TYPES",
    "ConfirmedUpload",
    "MediaKind",
    "UploadTicket",
]
