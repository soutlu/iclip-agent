"""公开对象存储的端口协议、对象元信息与错误类型；不依赖任何存储 SDK。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

SIGNED_PUT_EXPIRES_SECONDS = 3600
"""预签名 PUT 有效期，包含用户准备与大文件上传所需时间。"""


@dataclass(frozen=True, slots=True)
class StoredObject:
    """从桶读取的对象元信息，确认上传时的事实来源。"""

    object_key: str
    content_type: str
    size_bytes: int


class ObjectStoreUnavailable(Exception):
    """对象存储调用失败；由调用边界转换，不归入领域 HTTP 错误。"""


class PublicObjectStore(Protocol):
    """公开对象写入端口，供无需直传能力的调用方依赖。"""

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """写入公开对象，返回它的公网 URL；同 key 已存在即复用。"""
        ...


class SignedUploadStore(Protocol):
    """浏览器直传所需的签名、对象查询和 URL 构造端口。"""

    def sign_put(self, *, object_key: str, headers: Mapping[str, str]) -> str:
        """生成限时 PUT URL，有效期为 ``SIGNED_PUT_EXPIRES_SECONDS``。``headers`` 全部签进去：
        Content-Type 限制上传类型，``x-oss-meta-*`` 记审计；客户端必须原样带上。"""
        ...

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        """按前缀查询唯一对象；不存在返回 None，多个匹配视为错误。"""
        ...

    def public_url(self, object_key: str) -> str:
        """从 key 生成公网地址，支持更换域名而无需迁移持久化记录。"""
        ...


class PublicBucket(PublicObjectStore, SignedUploadStore, Protocol):
    """完整公开桶端口；消费者可依赖所需的较小接口。"""


__all__ = [
    "SIGNED_PUT_EXPIRES_SECONDS",
    "ObjectStoreUnavailable",
    "PublicBucket",
    "PublicObjectStore",
    "SignedUploadStore",
    "StoredObject",
]
