"""验证 FileSpace.resolve 的命名空间归一化与路径边界。"""

from __future__ import annotations

import pytest

from iclip.platform.file_store.store import FileSpace, InvalidPath
from tests.helpers.file_store import FakeFileStore


def space_yielding(namespace: str) -> FileSpace:

    return FileSpace(store=FakeFileStore(), namespace=lambda _ctx: namespace)


@pytest.mark.parametrize(
    ("given", "expected"),
    [("a//b", "a/b"), ("/a/b", "a/b"), ("a/b", "a/b")],
)
def test_namespace_is_canonicalized(given: str, expected: str) -> None:
    """统一命名空间写法，保证共享 FileSpace 的调用方能读取彼此的产物。"""

    assert space_yielding(given).resolve(object()) == expected


@pytest.mark.parametrize("given", ["../x", "a/../b", "a/./b", "", "x/"])
def test_illegal_namespace_is_refused(given: str) -> None:

    with pytest.raises(InvalidPath):
        space_yielding(given).resolve(object())


def test_a_failing_rule_is_not_swallowed() -> None:
    """命名空间解析错误须终止运行，公共空间回退会破坏用户隔离。"""

    def refuse(_ctx: object) -> str:
        raise RuntimeError("这次运行没有身份")

    with pytest.raises(RuntimeError, match="没有身份"):
        FileSpace(store=FakeFileStore(), namespace=refuse).resolve(object())
