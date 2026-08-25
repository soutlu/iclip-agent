"""``FileStore`` 的 Postgres 后端。表在 ``agent_runtime`` schema，DDL 由 Alembic 拥有。

**每次变更都先拿命名空间的 advisory 锁**，然后在 Python 里做判断，最后发一条
普通 upsert。这个顺序是想清楚的：

- 容量上限里的「命名空间总量」是**跨行聚合**。单条语句的原子性只保护同一行，
  不保护 ``SUM``——不加锁的话，两个运行同时写**不同**路径，各自查到的用量都
  没超，合起来把上限撑爆。这道缝只能用锁关。
- 拿到锁之后，那些把守卫条件塞进 ``ON CONFLICT ... WHERE``、再靠 ``RETURNING``
  猜结果的写法就没有存在理由了。它们的代价是：守卫不满足时返回 0 行，而「容
  量满」和「版本冲突」两种 0 行**分辨不出来**，可这两件事给模型的提示完全相
  反。锁下的先查后判，错误是精确的。
- 顺带还买到一件事：测试替身走的是同一条判定序列（查版本 → 查用量 → 判 →
  写），所以它和真库的行为几乎是机械对齐的，而不是靠人去维持一致。

``delete`` 也要拿锁。它对容量无害（只让总量变小），但不加锁它能插在写者的
「查」和「写」之间：写者查到文件存在、准备按版本更新，删除落地，upsert 就走
了 INSERT 分支，**静默新建**一个调用方明确声明「必须已存在」的文件。
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
    # 生成列：容量要按命名空间求和，让 PG 自己算就不可能和 content 对不上。
    # SQLAlchemy 认得 Computed，会自动把它从 INSERT/UPDATE 的列里排除（写生成
    # 列是 PG 的错误），所以这里不需要人去记着别碰它。
    Column("size_bytes", BigInteger, Computed("octet_length(content)", persisted=True)),
    Column("version", BigInteger, nullable=False),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False),
    Column("updated_at", TIMESTAMP(timezone=True), nullable=False),
    PrimaryKeyConstraint("namespace", "path"),
)


_BY_CODE_POINT = workspace_files_table.c.path.collate("C")
"""列目录与检索的排序键。

显式 ``COLLATE "C"``（按字节，UTF-8 下等于按码位），不吃数据库的默认排序规则：
那个规则跟着服务器 locale 变，同一份代码在两台机器上会给出不同的文件顺序。而且
按码位排才和 Python 的 ``sorted()`` 一致——存储替身就是那么排的，两边不一样的话
单测过了也说明不了真库的行为。文件清单的顺序没有语言学含义，稳定比"符合中文习
惯"重要。
"""


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
        """拿住这个命名空间的写锁，事务结束自动释放。

        ``hashtext`` 撞车只会让两个命名空间过度串行，不会保护不足；一个命名
        空间就是一个用户，争用本来就低。
        """

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
        # 单文件上限在客户端就能精确判断（内容全知），不必进事务。字节数用
        # UTF-8 算，和生成列的 octet_length 是同一个尺子。
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
                # 行不存在时 actual 是 None——即「文件已被删除」，绝不静默新建
                # 一个调用方声明必须已存在的文件。
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
        """清空整个命名空间，返回删掉几个文件。

        **不在 ``FileStore`` 协议上**：那套接口是给模型用的工具面，模型不该有
        「一次抹掉整块地盘」这种动作。这个方法只给宿主在删除对话时调用。

        照样先拿锁：不加锁它能插在写者的「查」和「写」之间，写者随后那条 upsert 就
        走 INSERT 分支，把刚删干净的地盘又留下一个文件。
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
            # 按段边界匹配，不用 LIKE：给的是 "分镜"，就不该把 "分镜稿.md" 也
            # 算进去。substr 相等是大小写敏感、逐字符精确的。
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
                        # SQL 只做预筛：ILIKE 在 PG 上折叠全部字符，是真正的超
                        # 集，最终判定和片段都归 build_matches。autoescape 让
                        # 查询里的 % 和 _ 当字面量，不当通配符。
                        table.c.content.icontains(query, autoescape=True),
                    )
                    .order_by(_BY_CODE_POINT)
                    .limit(MAX_SEARCH_FILES)
                )
            ).all()
        # 多要一条来判断「还有没报出来的」，然后裁掉。
        found = build_matches(((row[0], row[1]) for row in rows), query, limit=limit + 1)
        truncated = len(found) > limit or len(rows) >= MAX_SEARCH_FILES
        return SearchResult(matches=found[:limit], truncated=truncated)


__all__ = [
    "DB_SCHEMA",
    "PgFileStore",
    "metadata_obj",
    "workspace_files_table",
]
