"""阿里云 OSS 的公开对象读写。

签名、分片这些都由官方 SDK 负责，这里不重造——本文件只做几件官方 SDK 不管的事：
把 key 拼成公网 URL、把同步调用挪出事件循环、对网络故障与 5xx 再试几次（SDK 对普
通请求只发一次，一次读超时就直接抛）、把 SDK 的异常收成一种、把不属于本服务命名
空间的 key 挡在外面。

**为什么要有这一层。** 图片生成接口返回的是会过期的签名 URL，直接存进库里，过几
天链接就烂了。所以生成结果一到手就下载下来转存成自己的公开对象，库里存的是这个
不会过期的地址。

写入按稳定 key 做幂等：同一个 key 已经存在就直接复用，不重复上传。key 一律由
[layout.py](layout.py) 发，所以「同一次生成重跑一遍」不会在桶里堆垃圾。

**直传这条路为什么在这儿而不在业务侧。** 大文件（参考片能到几百 MB）穿过应用进程
是这一层当初就想避免的事，所以浏览器拿预签名 URL 直接 PUT 到桶里。签名是本地 HMAC
计算，不走网络。
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
"""一次读写最多发几次。只有网络故障与 OSS 那边的 5xx 才再发；4xx 再发也是同一个答案。"""

RETRY_BACKOFF_SECONDS = 1.0
"""两次尝试之间等多久，逐次线性加长。"""

SIGNED_PUT_EXPIRES_SECONDS = 3600
"""预签名 PUT 的有效期：这条地址过了这么久就不能再用来发起上传。

定得这么宽有两个原因，都不是「上传本来就要这么久」：一是挑文件、填表单那段时间也在
里面走，二是参考片能到几百 MB，慢网上传本身也不短。**没有去核实过一次跨越了到期时刻
的上传会不会被中途拒掉**，所以不要把余量压到刚好够传。
"""


@dataclass(frozen=True, slots=True)
class StoredObject:
    """桶里已经存在的一个对象。

    这三项都是桶自己说的，不是调用方报的：登记素材时全部事实都从这里来。
    """

    object_key: str
    content_type: str
    size_bytes: int


class ObjectStoreUnavailable(Exception):
    """对象存储不可达或拒绝了这次写入。

    和 identity 的 ``PmsUnavailable`` 同一个位置：外部系统的故障留在自己的边界
    上，不混进领域错误分类学（那套是给 HTTP 状态码用的，而这条路径上没有等在
    线上的请求）。
    """


class PublicObjectStore(Protocol):
    """把字节写到公开地址上的最小端口。

    只想写字节的调用方（生成结果转存、镜头帧落地）依赖这一个就够，不必认识直传那几
    件。测试给替身即可；换云厂商也只换实现。
    """

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """写入公开对象，返回它的公网 URL；同 key 已存在即复用。"""
        ...


class SignedUploadStore(Protocol):
    """浏览器直传这条路要用的三件。"""

    def sign_put(self, *, object_key: str, content_type: str) -> str:
        """签一条限时的 PUT 地址，交给浏览器直传。

        ``content_type`` 被签进签名里：拿着这条地址换一个类型去传，OSS 那边验签就
        不过。所以对象存下来时的类型是服务端定的，登记时读回来即可采信。
        """
        ...

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        """按前缀找唯一那个对象；没有就是 ``None``。

        直传是浏览器直接对着桶做的，服务端没有旁证——「到底传上来没有」只能来问桶。
        """
        ...

    def public_url(self, object_key: str) -> str:
        """把 key 拼成公网地址。

        库里存的是 key，地址是它的投影：换 CDN 域名只动一个环境变量，存量数据不用迁。
        """
        ...


class PublicBucket(PublicObjectStore, SignedUploadStore, Protocol):
    """整只桶。组合根注入的是它，各消费者按自己要的那一半声明依赖。"""


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
        # SDK 没有类型标注，显式标成 Any，免得每次取它的成员都被判成「类型不明」。
        self._bucket: Any = bucket if bucket is not None else _build_bucket(settings)

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """写入公开对象，返回公网 URL。

        oss2 是同步 SDK，上传要走网络，所以整段挪到线程里——留在事件循环上会把
        整个 worker 卡住。
        """

        key = _validate_object_key(object_key)
        if not content:
            raise ValueError("对象内容不能为空")
        await asyncio.to_thread(self._put, key, content, content_type)
        return self.public_url(key)

    def sign_put(self, *, object_key: str, content_type: str) -> str:
        """签一条限时的 PUT 地址。本地 HMAC，不走网络，可以直接在请求处理器里调。"""

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
                    # key 里的 / 不转义。不开这个的话签出来的地址是 uploads%2Fxxx，
                    # 传上去就成了一个名字里带斜杠的对象，和我们要的 key 不是同一个。
                    slash_safe=True,
                )
            )
        except oss2.exceptions.OssError as exc:  # pragma: no cover - 本地计算，理论上不会走到
            raise ObjectStoreUnavailable(f"OSS 签名失败: {exc}") from exc

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        """按前缀找唯一那个对象。列举与读元信息都走网络，所以整段挪到线程里。"""

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
        """同步上传；已存在即跳过。

        存在性检查与写入之间有竞争窗口，但 key 是内容确定的（同一次生成同一个
        key、同一份字节），两个 worker 同时写同一个 key 的结果一样，所以这个窗口
        没有后果。重试也是整段一起重：上一次的 PUT 其实已落地、只是等响应时超时的
        话，这一次的存在性检查直接放行，不会重传。
        """

        def once() -> None:
            if self._bucket.object_exists(object_key):
                return
            self._bucket.put_object(object_key, content, headers={"Content-Type": content_type})

        _with_retries(once, what="写入")


def _with_retries[T](action: Callable[[], T], *, what: str) -> T:
    """同步跑一次 OSS 调用，网络故障与 5xx 最多再发到 ``RETRY_ATTEMPTS`` 次；其余失败原地收成一种。"""

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
    """读超时、连接断开这类网络故障，以及 OSS 那边的 5xx：换个时刻再发多半就过了。"""

    return isinstance(exc, oss2.exceptions.RequestError) or exc.status >= 500


def _build_bucket(settings: OssSettings) -> oss2.Bucket:
    auth = oss2.Auth(settings.access_key_id, settings.access_key_secret)
    return oss2.Bucket(auth, settings.endpoint, settings.bucket)


def _validate_object_key(object_key: str) -> str:
    """拒掉能逃出本服务命名空间的 key。

    key 由 ``layout.py`` 发，但拼的那一步在别的模块里；这里当边界再挡一次，免得
    某个上游哪天把用户输入拼进去。命名空间那一条也在这里守：桶是公司共用的，少写
    一段前缀不该是「悄悄落到桶根上」，该是当场失败。
    """

    key = object_key.strip().strip("/")
    if not key:
        raise ValueError("对象 key 不能为空")
    if any(segment in {"", ".", ".."} for segment in key.split("/")):
        raise ValueError("对象 key 不能包含空段或 . / ..")
    if not key.startswith(f"{OSS_ROOT}/"):
        raise ValueError(f"对象 key 必须落在 {OSS_ROOT}/ 下面: {key}")
    return key


def validate_public_url_base(value: str) -> str:
    """校验公网访问前缀；启动期用，配置错了就别让服务起来。"""

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
