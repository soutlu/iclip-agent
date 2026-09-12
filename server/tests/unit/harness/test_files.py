"""工作区写入帮助函数把存储错误翻成带改法的 ModelRetry。"""

from __future__ import annotations

import pytest
from pydantic_ai import ModelRetry

from iclip.harness.files import write_or_retry
from tests.helpers.file_store import FakeFileStore

NAMESPACE = "owner/thread-1"


async def test_a_successful_write_returns_the_entry() -> None:
    files = FakeFileStore()

    entry = await write_or_retry(files, NAMESPACE, "稿.md", "正文")

    assert (entry.path, entry.version) == ("稿.md", 1)


async def test_file_limit_tells_the_model_to_split_the_content() -> None:
    files = FakeFileStore(max_file_bytes=10)

    with pytest.raises(ModelRetry, match="拆成几个文件"):
        await write_or_retry(files, NAMESPACE, "稿.md", "x" * 11)


async def test_namespace_limit_tells_the_model_to_delete_files() -> None:
    files = FakeFileStore(max_namespace_bytes=10)
    await write_or_retry(files, NAMESPACE, "a.md", "x" * 8)

    with pytest.raises(ModelRetry, match="list_files"):
        await write_or_retry(files, NAMESPACE, "b.md", "y" * 8)


async def test_version_conflict_tells_the_model_to_reread() -> None:
    files = FakeFileStore()
    await write_or_retry(files, NAMESPACE, "稿.md", "v1")

    with pytest.raises(ModelRetry, match="read_file"):
        await write_or_retry(files, NAMESPACE, "稿.md", "v2", expected_version=7)
