"""工作区存储的进程内替身。

刻意走**和 PG 实现同一条判定序列**：校验路径 → 判单文件上限 → 上锁 → 查版本 →
查用量 → 判总量 → 写。真库那边的顺序是想清楚才定的（先查后判换来精确错误），
替身照着走，单测通过才说明得上真库的行为。

一把 ``asyncio.Lock`` 对应真库那把命名空间 advisory 锁。粒度更粗（全局而非按命
名空间），对测试没影响，也不会让某个并发 bug 在这里蒙混过关。
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from iclip.capabilities.workspace.store import (
    DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_NAMESPACE_BYTES,
    MAX_SEARCH_FILES,
    FileEntry,
    QuotaExceeded,
    SearchResult,
    VersionConflict,
    WorkspaceFile,
    build_matches,
    normalize_path,
    validate_content,
)


@dataclass
class _Row:
    content: str
    version: int
    updated_at: datetime

    @property
    def size_bytes(self) -> int:
        return len(self.content.encode("utf-8"))


class FakeWorkspaceStore:
    """``WorkspaceStore`` 的内存实现。"""

    def __init__(
        self,
        *,
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
        max_namespace_bytes: int = DEFAULT_MAX_NAMESPACE_BYTES,
    ) -> None:
        self._rows: dict[tuple[str, str], _Row] = {}
        self._lock = asyncio.Lock()
        self._max_file_bytes = max_file_bytes
        self._max_namespace_bytes = max_namespace_bytes

    async def read(self, namespace: str, path: str) -> WorkspaceFile | None:
        key = normalize_path(path)
        row = self._rows.get((namespace, key))
        if row is None:
            return None
        return WorkspaceFile(path=key, content=row.content, version=row.version)

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        key = normalize_path(path)
        validate_content(content)
        size = len(content.encode("utf-8"))
        if size > self._max_file_bytes:
            raise QuotaExceeded(scope="file", attempted=size, limit=self._max_file_bytes, path=key)
        async with self._lock:
            current = self._rows.get((namespace, key))
            current_version = None if current is None else current.version
            if expected_version is not None and current_version != expected_version:
                raise VersionConflict(key, expected=expected_version, actual=current_version)
            used = sum(
                row.size_bytes for (space, _), row in self._rows.items() if space == namespace
            )
            total = used - (0 if current is None else current.size_bytes) + size
            if total > self._max_namespace_bytes:
                raise QuotaExceeded(
                    scope="namespace", attempted=total, limit=self._max_namespace_bytes
                )
            now = datetime.now(UTC)
            row = _Row(
                content=content,
                version=1 if current is None else current.version + 1,
                updated_at=now,
            )
            self._rows[(namespace, key)] = row
        return FileEntry(
            path=key, size_bytes=row.size_bytes, version=row.version, updated_at=row.updated_at
        )

    async def delete(self, namespace: str, path: str) -> bool:
        key = normalize_path(path)
        async with self._lock:
            return self._rows.pop((namespace, key), None) is not None

    async def entries(self, namespace: str, *, prefix: str = "") -> Sequence[FileEntry]:
        directory = normalize_path(prefix) if prefix else ""
        found: list[FileEntry] = []
        for (space, path), row in self._rows.items():
            if space != namespace:
                continue
            if directory and path != directory and not path.startswith(f"{directory}/"):
                continue
            found.append(
                FileEntry(
                    path=path,
                    size_bytes=row.size_bytes,
                    version=row.version,
                    updated_at=row.updated_at,
                )
            )
        return sorted(found, key=lambda entry: entry.path)

    async def search(self, namespace: str, query: str, *, limit: int) -> SearchResult:
        if not query:
            return SearchResult(matches=(), truncated=False)
        needle = query.lower()
        candidates = sorted(
            (path, row.content)
            for (space, path), row in self._rows.items()
            if space == namespace and needle in row.content.lower()
        )[:MAX_SEARCH_FILES]
        found = build_matches(candidates, query, limit=limit + 1)
        truncated = len(found) > limit or len(candidates) >= MAX_SEARCH_FILES
        return SearchResult(matches=found[:limit], truncated=truncated)


__all__ = ["FakeWorkspaceStore"]
