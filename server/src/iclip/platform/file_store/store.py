"""命名空间化文本文件的存储契约：路径语法、错误、后端 Protocol。

这些文件是 agent 自己写自己读的持久文本面——脚本草稿、分镜清单这类东西。放在
数据库而不是本地目录里，是因为服务多进程部署：本地目录只有写它的那个进程看
得见，换个进程接着干活就什么都找不到。

本模块不碰数据库，也不碰任何真实文件。路径校验是**纯字符串**的——不 resolve、
不 stat、不看软链接，因为这里根本没有 inode 可看。边界就是这套语法本身：段里
不许出现 ``.`` 与 ``..``，所以拼不出越界的路径；命名空间由调用方给定，模型连
它的存在都看不见。

错误故意不用 ``common.errors``：那一套是领域错误，会被 HTTP 处理器映射成状态
码。这里的错误是给模型看的（工具层翻成 ``ModelRetry`` 让它自己改），一旦漏进
HTTP 层就该是 500，而不是伪装成一个 409。
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
"""单个文件的字节上限。"""

DEFAULT_MAX_NAMESPACE_BYTES = 20_000_000
"""一个命名空间的总字节上限。"""

MAX_SEARCH_FILES = 200
"""单次检索最多扫多少个文件。撞上就在结果里标出来，不能悄悄少给。"""

MAX_MATCHES_PER_FILE = 3
"""同一个文件里最多报几处命中——一个词在一份稿子里出现几十次很常见。"""

MAX_SNIPPET_CHARS = 200
"""单条命中片段的字符上限。"""


class FileStoreError(Exception):
    """文件存储操作失败的基类。"""


class InvalidPath(FileStoreError):
    """路径不合语法。"""


class InvalidContent(FileStoreError):
    """内容里有存不进去的字节。"""


class VersionConflict(FileStoreError):
    """文件在读到与写回之间被别人改过（或删掉了）。"""

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
    """一个文件的全文与它的版本号。

    没有「截断」这回事：单文件有字节上限，所以整份读得下。``edit_file`` 是
    「读出来、改、写回去」，拿一份截断的内容去改再写回，文件后半截就静默消失
    了；存储层根本读不出半份内容，这条路就走不通。
    """

    path: str
    content: str
    version: int


@dataclass(frozen=True, slots=True)
class FileEntry:
    """一个文件的元信息（列目录与写入后回报都用它）。"""

    path: str
    size_bytes: int
    version: int
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class SearchMatch:
    """一处命中：哪个文件、第几行、那一行长什么样。"""

    path: str
    line: int
    snippet: str


@dataclass(frozen=True, slots=True)
class SearchResult:
    """检索结果。``truncated`` 为真表示还有没报出来的命中。"""

    matches: tuple[SearchMatch, ...]
    truncated: bool


def normalize_path(path: str) -> str:
    """校验并规范化一个文件路径，不合语法就抛 ``InvalidPath``。

    规范形式：相对路径、``/`` 分隔、无首尾斜杠。字符集不限 ASCII——``分镜/
    第一集.md`` 是这个产品里最正常的文件名。先做 NFC 规范化，免得同一个名字
    的两种 Unicode 写法变成两个文件。
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
    """挡住存不进 Postgres 的内容。

    PG 的 ``text`` 类型不能包含 NUL 字节。不挡的话，模型写进一个 ``\x00`` 会在
    驱动层炸成一个裸数据库错误——那是 500，出现在事件流中途，而不是一句它自己
    能改的提示。挡在这里也保证替身和真库对同一份输入给同一个答复。

    只拒绝、不清洗：悄悄把字节抹掉等于交付一份和模型以为自己写的不一样的文件。
    """

    if "\x00" in content:
        raise InvalidContent("内容里有 NUL 字节（\\x00），存不进去；把它去掉再写。")


def build_matches(
    files: Iterable[tuple[str, str]], query: str, *, limit: int
) -> tuple[SearchMatch, ...]:
    """在若干 ``(路径, 全文)`` 里找命中，逐行报位置。

    检索的正确性归 Python，不归 SQL。后端的 SQL 谓词只负责**预筛**候选行，最
    终判定和片段都由这个函数产出——所以 PG 实现和测试替身报出来的东西必然一
    样，不会出现「单测通过、真库行为不同」。

    大小写不敏感用 ``lower()`` 而不是 ``casefold()``：PG 的 ``ILIKE`` 按前者的
    规则折叠，两边得对齐。
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
    """命名空间化文本文件的存储后端。

    路径语法由实现方在每个方法里强制——这里是协议边界，将来多一个调用方也绕
    不过去。容量上限同理归实现方：它必须和写入落在同一个事务里，否则「查一下
    用量再写」中间那道缝就是超额的入口。
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
    """一处文件地盘：落在哪个后端，以及本次运行该用哪个命名空间。

    两样焊在一起，是因为它们必须配套：同一个后端配上不同的命名空间规则，两个调
    用方就各写各的地方——而且写和读都成功，只是彼此看不见。装配期造一个递给所有
    要用它的人，配错在结构上就不可能了。
    """

    store: FileStore

    namespace: Callable[[Any], str]
    """从本次运行算出命名空间。

    入参写成 ``Any`` 而不是引擎的运行上下文：这一层不认识那个框架（围栏也不许它
    认识）。真正的类型由调用方在自己那一侧标。
    """

    def resolve(self, ctx: Any) -> str:
        """算出本次运行的命名空间，并过一遍路径语法。

        命名空间是隔离根，混进 ``..`` 或空段，隔离就是纸做的。所有调用方都从这里
        要命名空间，「同一条规则、同一种规范化」才是结构保证的，而不是各自记得做。
        """

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
