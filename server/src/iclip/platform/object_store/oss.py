"""阿里云 OSS 的公开对象写入。

只有一件事要做：把一段字节放到一个稳定的 key 上，返回它的公网 URL。签名、分片、
重试这些都由官方 SDK 负责，这里不重造——本文件只做三件官方 SDK 不管的事：把
key 拼成公网 URL、把同步调用挪出事件循环、把 SDK 的异常收成一种。

**为什么要有这一层。** 图片生成接口返回的是会过期的签名 URL，直接存进库里，过几
天链接就烂了。所以生成结果一到手就下载下来转存成自己的公开对象，库里存的是这个
不会过期的地址。

写入按稳定 key 做幂等：同一个 key 已经存在就直接复用，不重复上传。key 由调用方
用业务 id 派生，所以「同一次生成重跑一遍」不会在桶里堆垃圾。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import quote, urlsplit

import oss2


class ObjectStoreUnavailable(Exception):
    """对象存储不可达或拒绝了这次写入。

    和 identity 的 ``PmsUnavailable`` 同一个位置：外部系统的故障留在自己的边界
    上，不混进领域错误分类学（那套是给 HTTP 状态码用的，而这条路径上没有等在
    线上的请求）。
    """


class PublicObjectStore(Protocol):
    """把字节写到公开地址上的最小端口。

    业务侧只依赖这个协议，测试给替身即可；换云厂商也只换实现。
    """

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """写入公开对象，返回它的公网 URL；同 key 已存在即复用。"""
        ...


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
        """``bucket`` 只给测试注入替身用；生产路径由 settings 自己造。"""

        self._public_url_base = settings.public_url_base.rstrip("/")
        self._bucket = bucket if bucket is not None else _build_bucket(settings)

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """写入公开对象，返回公网 URL。

        oss2 是同步 SDK，上传要走网络，所以整段挪到线程里——留在事件循环上会把
        整个 worker 卡住。
        """

        key = _validate_object_key(object_key)
        if not content:
            raise ValueError("对象内容不能为空")
        await asyncio.to_thread(self._put, key, content, content_type)
        return f"{self._public_url_base}/{quote(key, safe='/')}"

    def _put(self, object_key: str, content: bytes, content_type: str) -> None:
        """同步上传；已存在即跳过。

        存在性检查与写入之间有竞争窗口，但 key 是内容确定的（同一次生成同一个
        key、同一份字节），两个 worker 同时写同一个 key 的结果一样，所以这个窗口
        没有后果。
        """

        try:
            if self._bucket.object_exists(object_key):
                return
            self._bucket.put_object(object_key, content, headers={"Content-Type": content_type})
        except oss2.exceptions.OssError as exc:
            raise ObjectStoreUnavailable(f"OSS 写入失败: {exc}") from exc


def _build_bucket(settings: OssSettings) -> oss2.Bucket:
    auth = oss2.Auth(settings.access_key_id, settings.access_key_secret)
    return oss2.Bucket(auth, settings.endpoint, settings.bucket)


def _validate_object_key(object_key: str) -> str:
    """拒掉能逃出对象目录的 key。

    key 由业务 id 拼出来，但拼的那一步在别的模块里；这里当边界再挡一次，免得
    某个上游哪天把用户输入拼进去。
    """

    key = object_key.strip().strip("/")
    if not key:
        raise ValueError("对象 key 不能为空")
    if any(segment in {"", ".", ".."} for segment in key.split("/")):
        raise ValueError("对象 key 不能包含空段或 . / ..")
    return key


def validate_public_url_base(value: str) -> str:
    """校验公网访问前缀；启动期用，配置错了就别让服务起来。"""

    base = value.strip().rstrip("/")
    parts = urlsplit(base)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("对象存储的公网访问前缀必须是 http:// 或 https:// 地址")
    return base


__all__ = [
    "ObjectStoreUnavailable",
    "OssObjectStore",
    "OssSettings",
    "PublicObjectStore",
    "validate_public_url_base",
]
