"""FileStore 的 PostgreSQL 后端，agent_runtime 表由 Alembic 管理。

写入和删除共用命名空间 advisory 锁：容量为跨行聚合，需在锁内检查后写入；
先查版本再查容量可区分两类错误。删除也需持锁，避免并发 upsert 重建已删除文件。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from sqlalchemy import (
    BigInteger,
    Column,
    Computed,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    delete,
    func,
    or_,
    select,
    text,
)
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.platform.file_store.store import (
    DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_NAMESPACE_BYTES,
    MAX_SEARCH_FILES,
    FileEntry,
    QuotaExceeded,
    SearchResult,
    StoredFile,
    VersionConflict,
    build_matches,
    normalize_path,
    validate_content,
)

DB_SCHEMA: Final = "agent_runtime"

metadata_obj = MetaData(schema=DB_SCHEMA)

workspace_files_table = Table(
    "workspace_files",
    metadata_obj,
    Column("namespace", Text, nullable=False),
    Column("path", Text, nullable=False),
    Column("content", Text, nullable=False),
    # 生成列由 PostgreSQL 计算容量；Computed 排除 INSERT/UPDATE 显式赋值。
    Column("size_bytes", BigInteger, Computed("octet_length(content)", persisted=True)),
    Column("version", BigInteger, nullable=False),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False),
    Column("updated_at", TIMESTAMP(timezone=True), nullable=False),
    PrimaryKeyConstraint("namespace", "path"),
)


_BY_CODE_POINT = workspace_files_table.c.path.collate("C")
"""按 C collation 排序，避免服务器 locale 影响文件顺序，并与 Python sorted 保持一致。"""


class PgFileStore:
    """``FileStore`` 的 Postgres 实现。"""

    def __init__(
        self,
        engine: AsyncEngine,
        *,
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
        max_namespace_bytes: int = DEFAULT_MAX_NAMESPACE_BYTES,
    ) -> None:
        self._engine = engine
        self._max_file_bytes = max_file_bytes
        self._max_namespace_bytes = max_namespace_bytes

    async def _lock(self, conn: AsyncConnection, namespace: str) -> None:
        """持有命名空间写锁至事务结束；hashtext 冲突仅导致额外串行，不影响隔离正确性。"""

        await conn.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:namespace))"), {"namespace": namespace}
        )

    async def read(self, namespace: str, path: str) -> StoredFile | None:
        key = normalize_path(path)
        table = workspace_files_table
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(table.c.content, table.c.version).where(
                        table.c.namespace == namespace, table.c.path == key
                    )
                )
            ).first()
        if row is None:
            return None
        return StoredFile(path=key, content=row[0], version=int(row[1]))

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        key = normalize_path(path)
        validate_content(content)
        size = len(content.encode("utf-8"))
        # UTF-8 字节数与 octet_length 一致，单文件容量可在事务前检查。
        if size > self._max_file_bytes:
            raise QuotaExceeded(scope="file", attempted=size, limit=self._max_file_bytes, path=key)
        table = workspace_files_table
        async with self._engine.begin() as conn:
            await self._lock(conn, namespace)
            current = (
                await conn.execute(
                    select(table.c.version, table.c.size_bytes).where(
                        table.c.namespace == namespace, table.c.path == key
                    )
                )
            ).first()
            current_version = None if current is None else int(current[0])
            current_size = 0 if current is None else int(current[1])
            if expected_version is not None and current_version != expected_version:
                # actual=None 表示文件已删除，带预期版本的写入不得重新创建文件。
                raise VersionConflict(key, expected=expected_version, actual=current_version)
            used = (
                await conn.execute(
                    select(func.coalesce(func.sum(table.c.size_bytes), 0)).where(
                        table.c.namespace == namespace
                    )
                )
            ).scalar_one()
            total = int(used) - current_size + size
            if total > self._max_namespace_bytes:
                raise QuotaExceeded(
                    scope="namespace", attempted=total, limit=self._max_namespace_bytes
                )
            statement = pg_insert(table).values(
                namespace=namespace,
                path=key,
                content=content,
                version=1,
                created_at=func.now(),
                updated_at=func.now(),
            )
            statement = statement.on_conflict_do_update(
                index_elements=[table.c.namespace, table.c.path],
                set_={
                    "content": statement.excluded.content,
                    "version": table.c.version + 1,
                    "updated_at": func.now(),
                },
            ).returning(table.c.version, table.c.size_bytes, table.c.updated_at)
            written = (await conn.execute(statement)).one()
        return FileEntry(
            path=key, size_bytes=int(written[1]), version=int(written[0]), updated_at=written[2]
        )

    async def delete(self, namespace: str, path: str) -> bool:
        key = normalize_path(path)
        table = workspace_files_table
        async with self._engine.begin() as conn:
            await self._lock(conn, namespace)
            deleted = (
                await conn.execute(
                    delete(table)
                    .where(table.c.namespace == namespace, table.c.path == key)
                    .returning(table.c.path)
                )
            ).first()
        return deleted is not None

    async def purge_namespace(self, namespace: str) -> int:
        """宿主删除会话时清空命名空间；不向模型的 FileStore 协议暴露。

        需持写锁，防止并发 upsert 在清空后重建文件。
        """

        table = workspace_files_table
        async with self._engine.begin() as conn:
            await self._lock(conn, namespace)
            deleted = (
                await conn.execute(
                    delete(table).where(table.c.namespace == namespace).returning(table.c.path)
                )
            ).all()
        return len(deleted)

    async def entries(self, namespace: str, *, prefix: str = "") -> Sequence[FileEntry]:
        table = workspace_files_table
        conditions = [table.c.namespace == namespace]
        if prefix:
            directory = normalize_path(prefix)
            # 按目录段边界精确匹配，避免将同前缀文件名当作子目录。
            conditions.append(
                or_(
                    table.c.path == directory,
                    func.substr(table.c.path, 1, len(directory) + 1) == f"{directory}/",
                )
            )
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(table.c.path, table.c.size_bytes, table.c.version, table.c.updated_at)
                    .where(*conditions)
                    .order_by(_BY_CODE_POINT)
                )
            ).all()
        return [
            FileEntry(path=row[0], size_bytes=int(row[1]), version=int(row[2]), updated_at=row[3])
            for row in rows
        ]

    async def search(self, namespace: str, query: str, *, limit: int) -> SearchResult:
        if not query:
            return SearchResult(matches=(), truncated=False)
        table = workspace_files_table
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(table.c.path, table.c.content)
                    .where(
                        table.c.namespace == namespace,
                        # SQL 仅预筛，最终匹配由 build_matches 判定；autoescape 将 % 和 _ 视为字面量。
                        table.c.content.icontains(query, autoescape=True),
                    )
                    .order_by(_BY_CODE_POINT)
                    .limit(MAX_SEARCH_FILES)
                )
            ).all()
        # 多取一条判断是否截断。
        found = build_matches(((row[0], row[1]) for row in rows), query, limit=limit + 1)
        truncated = len(found) > limit or len(rows) >= MAX_SEARCH_FILES
        return SearchResult(matches=found[:limit], truncated=truncated)


__all__ = [
    "DB_SCHEMA",
    "PgFileStore",
    "metadata_obj",
    "workspace_files_table",
]
