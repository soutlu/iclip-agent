"""OSS 公开对象适配器：稳定 key 写入、直传签名、重试和异常映射。

同步网络调用在线程中执行；供应商生成结果转存后避免依赖临时签名 URL。
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import quote, urlsplit

import oss2

from iclip.platform.object_store.layout import OSS_ROOT

RETRY_ATTEMPTS = 3
"""网络错误与 5xx 的最大尝试次数；4xx 不重试。"""

RETRY_BACKOFF_SECONDS = 1.0
"""重试基础间隔，按尝试次数线性增加。"""

SIGNED_PUT_EXPIRES_SECONDS = 3600
"""预签名 PUT 有效期，包含用户准备与大文件上传所需时间。"""


@dataclass(frozen=True, slots=True)
class StoredObject:
    """从桶读取的对象元信息，作为素材登记的事实来源。"""

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

    def sign_put(self, *, object_key: str, content_type: str) -> str:
        """生成限时 PUT URL，并将 Content-Type 纳入签名，限制上传类型。"""
        ...

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        """按前缀查询唯一对象；不存在返回 None，多个匹配视为错误。"""
        ...

    def public_url(self, object_key: str) -> str:
        """从 key 生成公网地址，支持更换域名而无需迁移持久化记录。"""
        ...


class PublicBucket(PublicObjectStore, SignedUploadStore, Protocol):
    """完整公开桶端口；消费者可依赖所需的较小接口。"""


@dataclass(frozen=True, slots=True)
class OssSettings:
    """OSS 的运行值，由组合根从环境变量解析后传入。"""

    bucket: str
    endpoint: str
    access_key_id: str
    access_key_secret: str
    public_url_base: str
    """公网访问前缀（自定义域名或 bucket 默认域名），不带尾斜杠。"""


class OssObjectStore:
    """``PublicObjectStore`` 的 OSS 实现。"""

    def __init__(self, settings: OssSettings, *, bucket: Any | None = None) -> None:
        """允许注入 bucket 替身；未提供时按 settings 创建客户端。"""

        self._public_url_base = settings.public_url_base.rstrip("/")
        # OSS SDK 无类型标注，边界处显式使用 Any。
        self._bucket: Any = bucket if bucket is not None else _build_bucket(settings)

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """在线程中执行同步 OSS 上传，避免阻塞事件循环。"""

        key = _validate_object_key(object_key)
        if not content:
            raise ValueError("对象内容不能为空")
        await asyncio.to_thread(self._put, key, content, content_type)
        return self.public_url(key)

    def sign_put(self, *, object_key: str, content_type: str) -> str:
        """本地计算限时 PUT 签名，不发送网络请求。"""

        key = _validate_object_key(object_key)
        if not content_type.strip():
            raise ValueError("预签名 PUT 必须指定内容类型")
        try:
            return str(
                self._bucket.sign_url(
                    "PUT",
                    key,
                    SIGNED_PUT_EXPIRES_SECONDS,
                    headers={"Content-Type": content_type},
                    # 保留 key 中的斜杠，避免编码后上传到其他对象名。
                    slash_safe=True,
                )
            )
        except oss2.exceptions.OssError as exc:  # pragma: no cover - 本地计算，理论上不会走到
            raise ObjectStoreUnavailable(f"OSS 签名失败: {exc}") from exc

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        """在线程中执行对象列举及元信息查询。"""

        return await asyncio.to_thread(self._find, _validate_object_key(prefix))

    def public_url(self, object_key: str) -> str:
        return f"{self._public_url_base}/{quote(object_key, safe='/')}"

    def _find(self, prefix: str) -> StoredObject | None:
        entries = list(
            _with_retries(
                lambda: self._bucket.list_objects(prefix=prefix, max_keys=2).object_list,
                what="读取",
            )
        )
        if not entries:
            return None
        if len(entries) > 1:
            raise ObjectStoreUnavailable(f"前缀 {prefix} 下不止一个对象，无法确定是哪个")
        key = entries[0].key
        head = _with_retries(lambda: self._bucket.head_object(key), what="读取")
        return StoredObject(
            object_key=key,
            content_type=str(head.content_type or "").split(";")[0].strip(),
            size_bytes=int(head.content_length),
        )

    def _put(self, object_key: str, content: bytes, content_type: str) -> None:
        """已存在 key 直接复用；存在性检查与写入整体重试。

        稳定 key 对应确定内容，并发写入相同 key 不改变结果；响应超时后可通过检查避免重传。
        """

        def once() -> None:
            if self._bucket.object_exists(object_key):
                return
            self._bucket.put_object(object_key, content, headers={"Content-Type": content_type})

        _with_retries(once, what="写入")


def _with_retries[T](action: Callable[[], T], *, what: str) -> T:
    """执行同步调用；仅重试网络错误与 5xx，其他异常立即转换。"""

    attempt = 0
    while True:
        attempt += 1
        try:
            return action()
        except oss2.exceptions.OssError as exc:
            if attempt >= RETRY_ATTEMPTS or not _is_transient(exc):
                tried = f"（试了 {attempt} 次）" if attempt > 1 else ""
                raise ObjectStoreUnavailable(f"OSS {what}失败{tried}: {exc}") from exc
            time.sleep(RETRY_BACKOFF_SECONDS * attempt)


def _is_transient(exc: oss2.exceptions.OssError) -> bool:

    return isinstance(exc, oss2.exceptions.RequestError) or exc.status >= 500


def _build_bucket(settings: OssSettings) -> oss2.Bucket:
    auth = oss2.Auth(settings.access_key_id, settings.access_key_secret)
    return oss2.Bucket(auth, settings.endpoint, settings.bucket)


def _validate_object_key(object_key: str) -> str:
    """校验 key 的路径与命名空间，避免写入共享桶中本服务范围之外。"""

    key = object_key.strip().strip("/")
    if not key:
        raise ValueError("对象 key 不能为空")
    if any(segment in {"", ".", ".."} for segment in key.split("/")):
        raise ValueError("对象 key 不能包含空段或 . / ..")
    if not key.startswith(f"{OSS_ROOT}/"):
        raise ValueError(f"对象 key 必须落在 {OSS_ROOT}/ 下面: {key}")
    return key


def validate_public_url_base(value: str) -> str:
    """启动时校验公网 URL 前缀。"""

    base = value.strip().rstrip("/")
    parts = urlsplit(base)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("对象存储的公网访问前缀必须是 http:// 或 https:// 地址")
    return base


__all__ = [
    "RETRY_ATTEMPTS",
    "RETRY_BACKOFF_SECONDS",
    "SIGNED_PUT_EXPIRES_SECONDS",
    "ObjectStoreUnavailable",
    "OssObjectStore",
    "OssSettings",
    "PublicObjectStore",
    "StoredObject",
    "validate_public_url_base",
]
