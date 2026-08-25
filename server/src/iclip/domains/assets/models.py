"""素材账本的领域模型：一份素材这一行事实，以及收什么、收多大。

**账本里的每一行都是我们自己桶里的一个对象。** 外部地址（provider 的视频、外部图库
的图片）要进账本，得先转存过来——这是表结构上的硬约束：行上只有 ``object_key``，压根
没有放外部地址的地方。
"""

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
"""收哪些类型，各自算哪一类、在桶里叫什么扩展名。

一张表管三件事，是因为它们必须一起改：多收一种类型而忘了给扩展名，对象就会落到一个
没有后缀的 key 上。
"""

MAX_BYTES: Final[Mapping[AssetType, int]] = {
    "image": 16 * 1024 * 1024,
    "video": 512 * 1024 * 1024,
}
"""各类素材的大小上限。

**只在登记时卡得住。** 预签名 PUT 没法在签名里限定长度（那是 OSS 表单上传才有的
东西），所以超限的字节确实会先落进桶里；我们能保证的是它拿不到账本上的一行，随后被
按前缀清理掉。
"""


@dataclass(frozen=True, slots=True)
class UploadTicket:
    """一次直传的许可。

    它不是事实行，不落库：签名这一步不该在任何地方留下状态，登记要用的东西全都能从
    ``asset_id`` 重新算出来。
    """

    asset_id: uuid.UUID
    upload_url: str
    content_type: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class Asset:
    """账本上的一行。

    ``object_key`` 是身份，公网地址是它的投影——换 CDN 域名只动一个环境变量，存量
    数据不用迁。所以这里没有 url 字段。
    """

    id: uuid.UUID
    creator_user_id: uuid.UUID
    """谁传的。素材是全公司的，这一列只用来查与追责，不是访问边界。"""

    api_key_id: uuid.UUID | None
    """经 API key 传的记下是哪把 key 干的（可审计）。"""

    asset_type: AssetType
    object_key: str
    content_type: str
    size_bytes: int
    created_at: datetime


__all__ = ["MAX_BYTES", "UPLOAD_TYPES", "Asset", "AssetType", "UploadTicket"]
