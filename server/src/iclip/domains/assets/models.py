"""素材领域模型与上传限制。素材只记录本系统桶内的 object key；外部媒体须先转存。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

AssetType = Literal["image", "video"]

UPLOAD_TYPES: Final[Mapping[str, tuple[AssetType, str]]] = {
    "image/jpeg": ("image", "jpg"),
    "image/png": ("image", "png"),
    "image/webp": ("image", "webp"),
    "video/mp4": ("video", "mp4"),
    "video/quicktime": ("video", "mov"),
}
"""MIME 类型、素材种类与扩展名统一维护，确保支持的类型都有对应的对象后缀。"""

MAX_BYTES: Final[Mapping[AssetType, int]] = {
    "image": 16 * 1024 * 1024,
    "video": 512 * 1024 * 1024,
}
"""登记时校验大小上限；预签名 PUT 不限制上传长度，超限对象不会登记。"""

MIN_SHORT_EDGE_PIXELS: Final = 300
MAX_LONG_EDGE_PIXELS: Final = 6000
"""图片尺寸限制，不适用于视频分辨率。"""

IMPORT_NAMESPACE: Final = uuid.UUID("6f1f4e6a-0d1a-4c9d-9d0e-5f2a3b7c8d90")
"""源地址派生 assetId 的 UUID 命名空间；修改后存量转存记录将无法按原地址命中。"""


@dataclass(frozen=True, slots=True)
class UploadTicket:
    """无持久状态的直传凭证；登记所需的对象位置可由 asset_id 推导。"""

    asset_id: uuid.UUID
    upload_url: str
    content_type: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class Asset:
    """素材持久记录。仅存 object_key，公网地址按当前配置生成。"""

    id: uuid.UUID
    creator_user_id: uuid.UUID
    """上传者仅用于查询和审计；素材访问不按上传者隔离。"""

    api_key_id: uuid.UUID | None
    """记录上传时使用的 API key，供审计使用。"""

    asset_type: AssetType
    object_key: str
    content_type: str
    size_bytes: int
    created_at: datetime


__all__ = [
    "IMPORT_NAMESPACE",
    "MAX_BYTES",
    "MAX_LONG_EDGE_PIXELS",
    "MIN_SHORT_EDGE_PIXELS",
    "UPLOAD_TYPES",
    "Asset",
    "AssetType",
    "UploadTicket",
]
