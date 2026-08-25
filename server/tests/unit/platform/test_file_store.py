"""``FileSpace``：命名空间自己也要过路径语法。

这道守卫单独测，不搭在某一件能力的测试里：两件能力都从 ``resolve()`` 要命名空
间，而它曾经被拆成两个构造参数、其中一侧漏掉了规范化——整套测试照样全绿。所以
它需要一条只盯着它的测试。
"""

from __future__ import annotations

import pytest

from iclip.platform.file_store.store import FileSpace, InvalidPath
from tests.helpers.file_store import FakeFileStore


def space_yielding(namespace: str) -> FileSpace:
    """一片地盘，命名空间规则固定吐出给定的字符串。"""

    return FileSpace(store=FakeFileStore(), namespace=lambda _ctx: namespace)


@pytest.mark.parametrize(
    ("given", "expected"),
    [("a//b", "a/b"), ("/a/b", "a/b"), ("a/b", "a/b")],
)
def test_namespace_is_canonicalized(given: str, expected: str) -> None:
    """同一片地盘的两种写法必须算成同一个字符串。

    算不成同一个，两个调用方就各写各的地方——而且写和读都成功，只是彼此看不见。
    """

    assert space_yielding(given).resolve(object()) == expected


@pytest.mark.parametrize("given", ["../x", "a/../b", "a/./b", "", "x/"])
def test_illegal_namespace_is_refused(given: str) -> None:
    """命名空间是隔离根，混进 ``..`` 或空段就不再是隔离——拒绝，不是悄悄放行。"""

    with pytest.raises(InvalidPath):
        space_yielding(given).resolve(object())


def test_a_failing_rule_is_not_swallowed() -> None:
    """规则自己抛就让它抛：算不出地盘时唯一正确的行为是让这次运行失败。

    吞掉它退回某个公共命名空间，等于把所有人的文件并成一堆。
    """

    def refuse(_ctx: object) -> str:
        raise RuntimeError("这次运行没有身份")

    with pytest.raises(RuntimeError, match="没有身份"):
        FileSpace(store=FakeFileStore(), namespace=refuse).resolve(object())
