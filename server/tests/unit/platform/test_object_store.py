"""T-OSS-01：公开对象存储适配器的 key 边界、URL 拼接、幂等写与直传签名。

不打真 OSS：bucket 用替身。这一层自己只做这几件事（拼公网 URL、把同步调用挪出事件
循环、把 SDK 异常收成一种、把不属于本服务命名空间的 key 挡在外面），验的就是它们。
"""

from __future__ import annotations

import oss2
import pytest

from iclip.platform.object_store.layout import OSS_ROOT
from iclip.platform.object_store.oss import (
    ObjectStoreUnavailable,
    OssObjectStore,
    OssSettings,
    validate_public_url_base,
)

SETTINGS = OssSettings(
    bucket="iclip",
    endpoint="https://oss.test",
    access_key_id="ak",
    access_key_secret="sk",
    # 尾斜杠要被吃掉，否则拼出来的地址会多一道斜杠。
    public_url_base="https://cdn.test/",
)

KEY = f"{OSS_ROOT}/generated-images/a.png"


class FakeObjectInfo:
    def __init__(self, key: str) -> None:
        self.key = key


class FakeListing:
    def __init__(self, keys: list[str]) -> None:
        self.object_list = [FakeObjectInfo(key) for key in keys]


class FakeHead:
    def __init__(self, *, content_type: str, content_length: int) -> None:
        self.content_type = content_type
        self.content_length = content_length


class FakeBucket:
    def __init__(
        self,
        *,
        existing: set[str] | None = None,
        fail: bool = False,
        listed: list[str] | None = None,
        head: FakeHead | None = None,
    ) -> None:
        self.existing = existing or set()
        self.fail = fail
        self.listed = listed or []
        self.head = head
        self.writes: list[tuple[str, bytes, str]] = []
        self.signed: list[tuple[str, str, int, dict[str, str], bool]] = []

    def object_exists(self, object_key: str) -> bool:
        if self.fail:
            raise oss2.exceptions.RequestError(OSError("boom"))
        return object_key in self.existing

    def put_object(self, object_key: str, content: bytes, headers: dict[str, str]) -> None:
        self.writes.append((object_key, content, headers["Content-Type"]))

    def sign_url(
        self,
        method: str,
        key: str,
        expires: int,
        headers: dict[str, str] | None = None,
        slash_safe: bool = False,
    ) -> str:
        self.signed.append((method, key, expires, headers or {}, slash_safe))
        return f"https://oss.test/{key}?signed"

    def list_objects(self, prefix: str, max_keys: int) -> FakeListing:
        if self.fail:
            raise oss2.exceptions.RequestError(OSError("boom"))
        return FakeListing([key for key in self.listed if key.startswith(prefix)][:max_keys])

    def head_object(self, key: str) -> FakeHead:
        assert self.head is not None
        return self.head


def store(bucket: FakeBucket) -> OssObjectStore:
    return OssObjectStore(SETTINGS, bucket=bucket)


async def test_write_returns_public_url_and_encodes_the_key() -> None:
    bucket = FakeBucket()
    key = f"{OSS_ROOT}/generated-images/a b.png"
    url = await store(bucket).put_public_object(
        object_key=key, content=b"X", content_type="image/png"
    )

    assert url == f"https://cdn.test/{OSS_ROOT}/generated-images/a%20b.png"
    assert bucket.writes == [(key, b"X", "image/png")]


async def test_existing_key_is_reused_not_rewritten() -> None:
    """key 由业务 id 派生，内容确定，所以重跑一遍不该在桶里堆垃圾。"""

    bucket = FakeBucket(existing={KEY})
    url = await store(bucket).put_public_object(
        object_key=KEY, content=b"X", content_type="image/png"
    )

    assert url == f"https://cdn.test/{KEY}"
    assert bucket.writes == []


@pytest.mark.parametrize(
    "bad_key",
    [
        "",
        "   ",
        "/",
        f"{OSS_ROOT}/a//b",
        f"{OSS_ROOT}/../secrets/x.png",
        f"{OSS_ROOT}/a/./b.png",
    ],
)
async def test_keys_that_could_escape_the_prefix_are_rejected(bad_key: str) -> None:
    bucket = FakeBucket()
    with pytest.raises(ValueError):
        await store(bucket).put_public_object(
            object_key=bad_key, content=b"X", content_type="image/png"
        )
    assert bucket.writes == []


@pytest.mark.parametrize("outside", ["generated-images/a.png", "iclip/other/a.png", "a.png"])
async def test_keys_outside_our_namespace_are_rejected(outside: str) -> None:
    """桶是公司共用的：少写一段前缀不该是「悄悄落到桶根上」，该是当场失败。"""

    bucket = FakeBucket()
    with pytest.raises(ValueError, match=OSS_ROOT):
        await store(bucket).put_public_object(
            object_key=outside, content=b"X", content_type="image/png"
        )
    assert bucket.writes == []


async def test_empty_content_is_rejected() -> None:
    with pytest.raises(ValueError, match="不能为空"):
        await store(FakeBucket()).put_public_object(
            object_key=KEY, content=b"", content_type="image/png"
        )


async def test_sdk_failure_becomes_one_known_error() -> None:
    """调用方只需要认一种失败；不让 SDK 的异常类型漏到业务侧。"""

    with pytest.raises(ObjectStoreUnavailable):
        await store(FakeBucket(fail=True)).put_public_object(
            object_key=KEY, content=b"X", content_type="image/png"
        )


def test_signed_put_binds_the_content_type_and_keeps_slashes() -> None:
    """两件都不能少：类型被签进签名里，浏览器换一个就验签不过；斜杠不转义，
    否则传上去的是个名字里带 %2F 的对象，不是我们要的那个 key。"""

    bucket = FakeBucket()
    url = store(bucket).sign_put(object_key=KEY, content_type="image/png")

    assert url.endswith("?signed")
    method, key, expires, headers, slash_safe = bucket.signed[0]
    assert (method, key) == ("PUT", KEY)
    assert headers == {"Content-Type": "image/png"}
    assert slash_safe is True
    assert expires > 0


def test_signed_put_refuses_keys_outside_the_namespace() -> None:
    bucket = FakeBucket()
    with pytest.raises(ValueError, match=OSS_ROOT):
        store(bucket).sign_put(object_key="uploads/a.png", content_type="image/png")
    assert bucket.signed == []


async def test_find_object_reports_what_the_bucket_says() -> None:
    """登记要用的三项事实全从桶里读回来，不采信调用方的任何声明。"""

    bucket = FakeBucket(listed=[KEY], head=FakeHead(content_type="image/png", content_length=7))

    found = await store(bucket).find_object(prefix=f"{OSS_ROOT}/generated-images/a.")

    assert found is not None
    assert (found.object_key, found.content_type, found.size_bytes) == (KEY, "image/png", 7)


async def test_find_object_returns_none_when_nothing_was_uploaded() -> None:
    found = await store(FakeBucket()).find_object(prefix=f"{OSS_ROOT}/uploads/x.")

    assert found is None


async def test_find_object_refuses_an_ambiguous_prefix() -> None:
    """一个前缀底下不该有两个对象；真有就是出了别的问题，不能随便挑一个登记。"""

    bucket = FakeBucket(
        listed=[f"{OSS_ROOT}/uploads/x.png", f"{OSS_ROOT}/uploads/x.mp4"],
        head=FakeHead(content_type="image/png", content_length=1),
    )

    with pytest.raises(ObjectStoreUnavailable):
        await store(bucket).find_object(prefix=f"{OSS_ROOT}/uploads/x.")


@pytest.mark.parametrize("bad_base", ["", "cdn.test", "ftp://cdn.test", "   "])
def test_public_url_base_must_be_http(bad_base: str) -> None:
    """配错了就别让服务起来——运行期才发现的话，库里已经存了一批拼错的地址。"""

    with pytest.raises(ValueError):
        validate_public_url_base(bad_base)


def test_public_url_base_trailing_slash_is_trimmed() -> None:
    assert validate_public_url_base("https://cdn.test/") == "https://cdn.test"
