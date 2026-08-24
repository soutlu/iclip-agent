"""T-OSS-01：公开对象存储适配器的 key 边界、URL 拼接与幂等写。

不打真 OSS：bucket 用替身。这一层自己只做三件事（拼公网 URL、把同步调用挪出事件
循环、把 SDK 异常收成一种），验的就是这三件。
"""

from __future__ import annotations

import oss2
import pytest

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


class FakeBucket:
    def __init__(self, *, existing: set[str] | None = None, fail: bool = False) -> None:
        self.existing = existing or set()
        self.fail = fail
        self.writes: list[tuple[str, bytes, str]] = []

    def object_exists(self, object_key: str) -> bool:
        if self.fail:
            raise oss2.exceptions.RequestError(OSError("boom"))
        return object_key in self.existing

    def put_object(self, object_key: str, content: bytes, headers: dict[str, str]) -> None:
        self.writes.append((object_key, content, headers["Content-Type"]))


def store(bucket: FakeBucket) -> OssObjectStore:
    return OssObjectStore(SETTINGS, bucket=bucket)


async def test_write_returns_public_url_and_encodes_the_key() -> None:
    bucket = FakeBucket()
    url = await store(bucket).put_public_object(
        object_key="generated-images/a b.png", content=b"X", content_type="image/png"
    )

    assert url == "https://cdn.test/generated-images/a%20b.png"
    assert bucket.writes == [("generated-images/a b.png", b"X", "image/png")]


async def test_existing_key_is_reused_not_rewritten() -> None:
    """key 由业务 id 派生，内容确定，所以重跑一遍不该在桶里堆垃圾。"""

    bucket = FakeBucket(existing={"generated-images/a.png"})
    url = await store(bucket).put_public_object(
        object_key="generated-images/a.png", content=b"X", content_type="image/png"
    )

    assert url == "https://cdn.test/generated-images/a.png"
    assert bucket.writes == []


@pytest.mark.parametrize("bad_key", ["", "   ", "/", "a//b", "../secrets/x.png", "a/./b.png"])
async def test_keys_that_could_escape_the_prefix_are_rejected(bad_key: str) -> None:
    bucket = FakeBucket()
    with pytest.raises(ValueError):
        await store(bucket).put_public_object(
            object_key=bad_key, content=b"X", content_type="image/png"
        )
    assert bucket.writes == []


async def test_empty_content_is_rejected() -> None:
    with pytest.raises(ValueError, match="不能为空"):
        await store(FakeBucket()).put_public_object(
            object_key="a/b.png", content=b"", content_type="image/png"
        )


async def test_sdk_failure_becomes_one_known_error() -> None:
    """调用方只需要认一种失败；不让 SDK 的异常类型漏到业务侧。"""

    with pytest.raises(ObjectStoreUnavailable):
        await store(FakeBucket(fail=True)).put_public_object(
            object_key="a/b.png", content=b"X", content_type="image/png"
        )


@pytest.mark.parametrize("bad_base", ["", "cdn.test", "ftp://cdn.test", "   "])
def test_public_url_base_must_be_http(bad_base: str) -> None:
    """配错了就别让服务起来——运行期才发现的话，库里已经存了一批拼错的地址。"""

    with pytest.raises(ValueError):
        validate_public_url_base(bad_base)


def test_public_url_base_trailing_slash_is_trimmed() -> None:
    assert validate_public_url_base("https://cdn.test/") == "https://cdn.test"
