"""命名空间文本存储的路径、错误和后端协议。

路径为逻辑字符串，无本地 inode；命名空间由宿主提供。存储错误由工具层转换为
ModelRetry，不使用领域 HTTP 错误分类。
"""

from __future__ import annotations

import unicodedata
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol

MAX_PATH_CHARS = 512
MAX_SEGMENTS = 16
MAX_SEGMENT_CHARS = 128

DEFAULT_MAX_FILE_BYTES = 1_000_000

DEFAULT_MAX_NAMESPACE_BYTES = 20_000_000

MAX_SEARCH_FILES = 200
"""检索候选文件上限，超出时标记结果截断。"""

MAX_MATCHES_PER_FILE = 3
"""每文件命中上限，避免高频词占满结果。"""

MAX_SNIPPET_CHARS = 200


class FileStoreError(Exception):
    """文件存储操作失败的基类。"""


class InvalidPath(FileStoreError):
    """路径不合语法。"""


class InvalidContent(FileStoreError):
    """内容包含后端不支持的字节。"""


class VersionConflict(FileStoreError):
    """预期版本与当前文件不一致，包括文件已删除的情形。"""

    def __init__(self, path: str, *, expected: int, actual: int | None) -> None:
        if actual is None:
            super().__init__(f"{path} 已经被删除了（期望版本 {expected}）")
        else:
            super().__init__(f"{path} 已经被改过：期望版本 {expected}，实际 {actual}")
        self.path = path
        self.expected = expected
        self.actual = actual


class QuotaExceeded(FileStoreError):
    """写入会超出容量上限。"""

    def __init__(
        self,
        *,
        scope: Literal["file", "namespace"],
        attempted: int,
        limit: int,
        path: str | None = None,
    ) -> None:
        if scope == "file":
            super().__init__(f"{path} 会变成 {attempted} 字节，超过单文件上限 {limit} 字节")
        else:
            super().__init__(f"工作区会占用 {attempted} 字节，超过总上限 {limit} 字节")
        self.scope = scope
        self.attempted = attempted
        self.limit = limit
        self.path = path


@dataclass(frozen=True, slots=True)
class StoredFile:
    """文件全文与版本号。

    读取不截断，避免编辑工具将截断内容写回后丢失文件尾部。
    """

    path: str
    content: str
    version: int


@dataclass(frozen=True, slots=True)
class FileEntry:
    """用于目录列表与写入结果的文件元信息。"""

    path: str
    size_bytes: int
    version: int
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class SearchMatch:
    """带文件路径、行号和片段的检索命中。"""

    path: str
    line: int
    snippet: str


@dataclass(frozen=True, slots=True)
class SearchResult:
    """检索结果。``truncated`` 为真表示还有没报出来的命中。"""

    matches: tuple[SearchMatch, ...]
    truncated: bool


def normalize_path(path: str) -> str:
    """校验并规范化相对路径，失败时抛 InvalidPath。

    使用 NFC 归一化 Unicode，统一 / 分隔且无首尾斜杠，避免等价文件名重复。
    """

    value = unicodedata.normalize("NFC", path)
    if any(unicodedata.category(ch) == "Cc" for ch in value):
        raise InvalidPath(f"路径 {path!r} 里有控制字符")
    if "\\" in value:
        raise InvalidPath(f"路径 {path!r} 用了反斜杠，请用 /")
    while "//" in value:
        value = value.replace("//", "/")
    value = value.removeprefix("/")
    if value.endswith("/"):
        raise InvalidPath(f"路径 {path!r} 以 / 结尾；路径指向文件，不是目录")
    if not value:
        raise InvalidPath("路径是空的")
    if len(value) > MAX_PATH_CHARS:
        raise InvalidPath(f"路径 {path!r} 超过 {MAX_PATH_CHARS} 个字符")
    segments = value.split("/")
    if len(segments) > MAX_SEGMENTS:
        raise InvalidPath(f"路径 {path!r} 超过 {MAX_SEGMENTS} 层")
    for segment in segments:
        if segment in (".", ".."):
            raise InvalidPath(f"路径 {path!r} 里不许出现 . 或 .. 这样的段")
        if len(segment) > MAX_SEGMENT_CHARS:
            raise InvalidPath(f"路径 {path!r} 有一段超过 {MAX_SEGMENT_CHARS} 个字符")
    return value


def validate_content(content: str) -> None:
    """拒绝 PostgreSQL text 不支持的 NUL，保持原内容而不静默删除字节。

    在驱动调用前返回存储错误，使工具层可提示模型修正。
    """

    if "\x00" in content:
        raise InvalidContent("内容里有 NUL 字节（\\x00），存不进去；把它去掉再写。")


def build_matches(
    files: Iterable[tuple[str, str]], query: str, *, limit: int
) -> tuple[SearchMatch, ...]:
    """按行生成最终检索结果；SQL 仅预筛候选，内存替身共用本函数。

    使用 lower 与 PostgreSQL ILIKE 的折叠规则对齐，不使用 casefold。
    """

    needle = query.lower()
    matches: list[SearchMatch] = []
    for path, content in files:
        hits = 0
        for number, line in enumerate(content.splitlines(), start=1):
            if needle not in line.lower():
                continue
            snippet = line.strip()
            if len(snippet) > MAX_SNIPPET_CHARS:
                snippet = snippet[:MAX_SNIPPET_CHARS] + "…"
            matches.append(SearchMatch(path=path, line=number, snippet=snippet))
            hits += 1
            if hits >= MAX_MATCHES_PER_FILE or len(matches) >= limit:
                break
        if len(matches) >= limit:
            break
    return tuple(matches)


class FileStore(Protocol):
    """命名空间文本文件后端。

    实现须统一校验路径，并在同一事务中检查容量和写入，保证并发容量约束。
    """

    async def read(self, namespace: str, path: str) -> StoredFile | None: ...

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry: ...

    async def delete(self, namespace: str, path: str) -> bool: ...

    async def entries(self, namespace: str, *, prefix: str = "") -> Sequence[FileEntry]: ...

    async def search(self, namespace: str, query: str, *, limit: int) -> SearchResult: ...


@dataclass(frozen=True, slots=True)
class FileSpace:
    """绑定存储后端与命名空间规则，供共享工作区的调用方复用。"""

    store: FileStore

    namespace: Callable[[Any], str]
    """由运行上下文解析命名空间；平台不依赖引擎类型，具体类型由调用方声明。"""

    def resolve(self, ctx: Any) -> str:
        """解析并规范化命名空间，统一所有调用方的隔离边界。"""

        return normalize_path(self.namespace(ctx))


__all__ = [
    "DEFAULT_MAX_FILE_BYTES",
    "DEFAULT_MAX_NAMESPACE_BYTES",
    "MAX_MATCHES_PER_FILE",
    "MAX_PATH_CHARS",
    "MAX_SEARCH_FILES",
    "MAX_SEGMENTS",
    "MAX_SEGMENT_CHARS",
    "MAX_SNIPPET_CHARS",
    "FileEntry",
    "FileSpace",
    "FileStore",
    "FileStoreError",
    "InvalidContent",
    "InvalidPath",
    "QuotaExceeded",
    "SearchMatch",
    "SearchResult",
    "StoredFile",
    "VersionConflict",
    "build_matches",
    "normalize_path",
    "validate_content",
]
