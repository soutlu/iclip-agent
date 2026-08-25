"""PgFileStore 对真实 Postgres 的验收。

重点不是「读写通不通」，而是几件只有真库才能证明的事：生成列自己算得对、
``pg_advisory_xact_lock`` 真的把跨行的容量聚合关严了、CAS 报得出实际版本、
以及 PG 的 ``text`` 存不了 NUL 这件事被挡在了驱动之前。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.platform.file_store.pg import PgFileStore
from iclip.platform.file_store.store import (
    InvalidContent,
    InvalidPath,
    QuotaExceeded,
    VersionConflict,
)


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE agent_runtime.workspace_files"))
    yield engine
    await engine.dispose()


@pytest.fixture
def store(engine: AsyncEngine) -> PgFileStore:
    return PgFileStore(engine)


@pytest.fixture
def namespace() -> str:
    return str(uuid.uuid4())


async def test_round_trip_and_version_bump(store: PgFileStore, namespace: str) -> None:
    first = await store.write(namespace, "分镜/第一集.md", "镜头一")
    assert (first.version, first.size_bytes) == (1, len("镜头一".encode()))

    second = await store.write(namespace, "分镜/第一集.md", "镜头一\n镜头二")
    assert second.version == 2
    assert second.updated_at >= first.updated_at

    stored = await store.read(namespace, "分镜/第一集.md")
    assert stored is not None
    assert (stored.content, stored.version) == ("镜头一\n镜头二", 2)


async def test_generated_column_matches_the_content(
    store: PgFileStore, engine: AsyncEngine, namespace: str
) -> None:
    """size_bytes 由 PG 自己算，不可能和 content 漂移——容量上限就靠它。"""

    content = "中文和 ascii 混排"
    await store.write(namespace, "稿.md", content)
    async with engine.connect() as conn:
        size = (
            await conn.execute(
                text(
                    "SELECT size_bytes FROM agent_runtime.workspace_files "
                    "WHERE namespace = :ns AND path = '稿.md'"
                ),
                {"ns": namespace},
            )
        ).scalar_one()
    assert size == len(content.encode())


async def test_stale_version_reports_the_actual_one(store: PgFileStore, namespace: str) -> None:
    await store.write(namespace, "稿.md", "一稿")
    await store.write(namespace, "稿.md", "二稿")
    with pytest.raises(VersionConflict) as raised:
        await store.write(namespace, "稿.md", "基于一稿改的", expected_version=1)
    assert raised.value.actual == 2
    # 冲突不能把内容改掉。
    stored = await store.read(namespace, "稿.md")
    assert stored is not None and stored.content == "二稿"


async def test_cas_on_a_deleted_file_never_silently_recreates_it(
    store: PgFileStore, namespace: str
) -> None:
    """带版本号写一个已经不存在的文件是冲突，不是新建。"""

    await store.write(namespace, "稿.md", "一稿")
    assert await store.delete(namespace, "稿.md") is True
    with pytest.raises(VersionConflict) as raised:
        await store.write(namespace, "稿.md", "接着改", expected_version=1)
    assert raised.value.actual is None
    assert await store.read(namespace, "稿.md") is None


async def test_delete_reports_whether_anything_was_there(
    store: PgFileStore, namespace: str
) -> None:
    assert await store.delete(namespace, "没有.md") is False
    await store.write(namespace, "有.md", "x")
    assert await store.delete(namespace, "有.md") is True


async def test_nul_bytes_are_refused_before_the_driver_sees_them(
    store: PgFileStore, namespace: str
) -> None:
    """PG 的 text 存不了 NUL。不挡就是一个裸驱动错误，而不是一句能重试的话。"""

    with pytest.raises(InvalidContent):
        await store.write(namespace, "稿.md", "前\x00后")


async def test_illegal_paths_never_reach_the_database(store: PgFileStore, namespace: str) -> None:
    """路径语法在存储层强制——这里是协议边界，绕不过去。"""

    with pytest.raises(InvalidPath):
        await store.write(namespace, "../越界.md", "x")
    with pytest.raises(InvalidPath):
        await store.read(namespace, "../越界.md")


async def test_oversized_file_is_refused(engine: AsyncEngine, namespace: str) -> None:
    store = PgFileStore(engine, max_file_bytes=64)
    with pytest.raises(QuotaExceeded) as raised:
        await store.write(namespace, "稿.md", "x" * 65)
    assert raised.value.scope == "file"


async def test_overwrite_counts_only_the_delta(engine: AsyncEngine, namespace: str) -> None:
    """覆盖同一个文件不该被自己的旧内容挡住，否则一撞上限就再也改不动了。"""

    store = PgFileStore(engine, max_namespace_bytes=100)
    await store.write(namespace, "稿.md", "x" * 90)
    written = await store.write(namespace, "稿.md", "y" * 95)
    assert written.size_bytes == 95


async def test_namespace_quota_holds_under_concurrent_writes_to_different_paths(
    engine: AsyncEngine, namespace: str
) -> None:
    """这条是那把 advisory 锁的存在理由。

    命名空间总量是跨行聚合，单条语句的原子性保护不了它：不加锁的话，两个并发
    写各自查到的用量都没超上限，双双放行，合起来把上限撑爆。加了锁之后两者串
    行，第二个必须看见第一个已经落地的用量并被拒。
    """

    # 预热连接池是承重的一步，不是优化：池里没有现成连接时，第二个写要先做一
    # 次完整的建连握手，等它握完第一个写早就整个事务提交了——两个写被迫串行，
    # 这条测试就会在**没有锁**的情况下照样通过，证明不了任何东西。先把两条连
    # 接建好，两个写才真的交错。
    warmed = await asyncio.gather(engine.connect(), engine.connect())
    await asyncio.gather(*(connection.close() for connection in warmed))

    store = PgFileStore(engine, max_namespace_bytes=100)
    results = await asyncio.gather(
        store.write(namespace, "a.md", "x" * 80),
        store.write(namespace, "b.md", "y" * 80),
        return_exceptions=True,
    )
    refused = [item for item in results if isinstance(item, QuotaExceeded)]
    assert len(refused) == 1, f"两个并发写都放行了，上限被撑爆: {results}"
    assert refused[0].scope == "namespace"

    entries = await store.entries(namespace)
    assert sum(entry.size_bytes for entry in entries) <= 100


async def test_entries_scope_by_segment_boundary_and_sort(
    store: PgFileStore, namespace: str
) -> None:
    await store.write(namespace, "分镜/第二集.md", "b")
    await store.write(namespace, "分镜/第一集.md", "a")
    await store.write(namespace, "分镜稿.md", "c")

    everything = [entry.path for entry in await store.entries(namespace)]
    assert everything == sorted(everything)

    scoped = [entry.path for entry in await store.entries(namespace, prefix="分镜")]
    assert scoped == ["分镜/第一集.md", "分镜/第二集.md"]


async def test_namespaces_are_isolated(store: PgFileStore) -> None:
    mine, theirs = str(uuid.uuid4()), str(uuid.uuid4())
    await store.write(mine, "稿.md", "我的")
    assert await store.read(theirs, "稿.md") is None
    assert await store.entries(theirs) == []


async def test_search_matches_lines_case_insensitively(store: PgFileStore, namespace: str) -> None:
    await store.write(namespace, "稿.md", "开场是夜景\n中段是雨\n结尾也是夜景")
    await store.write(namespace, "笔记.md", "SCENE 100")

    result = await store.search(namespace, "夜景", limit=10)
    assert [(match.path, match.line) for match in result.matches] == [("稿.md", 1), ("稿.md", 3)]

    lowered = await store.search(namespace, "scene", limit=10)
    assert [match.path for match in lowered.matches] == ["笔记.md"]


async def test_search_treats_wildcards_as_literal_text(store: PgFileStore, namespace: str) -> None:
    """``%`` 当通配符会让检索命中一切；它必须是字面量。"""

    await store.write(namespace, "稿.md", "进度 100%\n别的行")
    assert (await store.search(namespace, "100%", limit=10)).matches
    assert not (await store.search(namespace, "%别的", limit=10)).matches


async def test_search_says_when_it_held_matches_back(store: PgFileStore, namespace: str) -> None:
    await store.write(namespace, "a.md", "夜景")
    await store.write(namespace, "b.md", "夜景")
    result = await store.search(namespace, "夜景", limit=1)
    assert len(result.matches) == 1
    assert result.truncated is True


async def test_search_caps_matches_per_file(store: PgFileStore, namespace: str) -> None:
    """一个词在一份稿子里出现几十次很常见，不能让一个文件占满整个结果。"""

    await store.write(namespace, "稿.md", "\n".join("夜景" for _ in range(20)))
    result = await store.search(namespace, "夜景", limit=10)
    assert len(result.matches) == 3
