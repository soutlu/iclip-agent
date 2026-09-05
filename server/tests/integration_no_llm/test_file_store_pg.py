"""验证 PgFileStore 的生成列、容量并发约束、CAS 和 PostgreSQL text 输入边界。"""

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
    stored = await store.read(namespace, "稿.md")
    assert stored is not None and stored.content == "二稿"


async def test_cas_on_a_deleted_file_never_silently_recreates_it(
    store: PgFileStore, namespace: str
) -> None:

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
    """PostgreSQL text 不接受 NUL，存储层应在驱动调用前拒绝。"""

    with pytest.raises(InvalidContent):
        await store.write(namespace, "稿.md", "前\x00后")


async def test_illegal_paths_never_reach_the_database(store: PgFileStore, namespace: str) -> None:

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

    store = PgFileStore(engine, max_namespace_bytes=100)
    await store.write(namespace, "稿.md", "x" * 90)
    written = await store.write(namespace, "稿.md", "y" * 95)
    assert written.size_bytes == 95


async def test_namespace_quota_holds_under_concurrent_writes_to_different_paths(
    engine: AsyncEngine, namespace: str
) -> None:
    """跨行容量聚合需要 advisory 锁，防止并发写入分别通过检查后超额。"""

    # 预建两条连接，避免建连耗时导致写入串行，使缺锁的实现也能通过测试。
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

    await store.write(namespace, "稿.md", "\n".join("夜景" for _ in range(20)))
    result = await store.search(namespace, "夜景", limit=10)
    assert len(result.matches) == 3
