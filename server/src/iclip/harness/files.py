"""工具写工作区文件时，把存储错误翻成模型可纠正的退回。"""

from __future__ import annotations

from pydantic_ai import ModelRetry

from iclip.platform.file_store.store import (
    FileEntry,
    FileStore,
    InvalidContent,
    QuotaExceeded,
    VersionConflict,
)


async def write_or_retry(
    files: FileStore,
    namespace: str,
    path: str,
    content: str,
    *,
    expected_version: int | None = None,
) -> FileEntry:
    """写入文件；内容、配额与版本问题抛 ModelRetry，并提示模型怎么改。"""

    try:
        return await files.write(namespace, path, content, expected_version=expected_version)
    except InvalidContent as exc:
        raise ModelRetry(str(exc)) from exc
    except QuotaExceeded as exc:
        if exc.scope == "file":
            raise ModelRetry(f"{exc}。把内容拆成几个文件，或者精简一些。") from exc
        raise ModelRetry(f"{exc}。用 list_files 找出不再需要的文件删掉。") from exc
    except VersionConflict as exc:
        raise ModelRetry(f"{exc}。用 read_file 重新读一遍，再基于新内容改。") from exc


__all__ = ["write_or_retry"]
