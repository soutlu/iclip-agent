"""验证 PgMaterialLedger 的冲突去重、URL 精确匹配和命名空间隔离。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.platform.material_ledger.pg import PgMaterialLedger
from iclip.platform.material_ledger.store import Material

VIDEO = "https://cdn.test/ref.mp4"
IMAGE = "https://cdn.test/poster.jpg?x-oss-process=image/resize,l_1024"


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE agent_runtime.materials"))
    yield engine
    await engine.dispose()


@pytest.fixture
def ledger(engine: AsyncEngine) -> PgMaterialLedger:
    return PgMaterialLedger(engine)


@pytest.fixture
def namespace() -> str:
    return str(uuid.uuid4())


async def test_records_and_looks_up_each_kind(ledger: PgMaterialLedger, namespace: str) -> None:
    await ledger.record(
        namespace, [Material(url=VIDEO, kind="video"), Material(url=IMAGE, kind="image")]
    )

    assert await ledger.lookup(namespace, VIDEO) == Material(url=VIDEO, kind="video")
    assert await ledger.lookup(namespace, IMAGE) == Material(url=IMAGE, kind="image")


async def test_recording_the_same_url_twice_keeps_the_first_row(
    ledger: PgMaterialLedger, engine: AsyncEngine, namespace: str
) -> None:

    await ledger.record(namespace, [Material(url=VIDEO, kind="video")])
    await ledger.record(namespace, [Material(url=VIDEO, kind="image")])

    async with engine.connect() as conn:
        rows = (
            await conn.execute(
                text("SELECT kind FROM agent_runtime.materials WHERE namespace = :ns"),
                {"ns": namespace},
            )
        ).all()
    assert [row[0] for row in rows] == ["video"]


async def test_the_same_url_twice_in_one_batch_is_fine(
    ledger: PgMaterialLedger, namespace: str
) -> None:
    """同一消息可以重复引用素材；批量登记不能因重复 URL 失败。"""

    await ledger.record(
        namespace, [Material(url=IMAGE, kind="image"), Material(url=IMAGE, kind="image")]
    )

    assert await ledger.lookup(namespace, IMAGE) == Material(url=IMAGE, kind="image")


async def test_lookup_matches_the_whole_url(ledger: PgMaterialLedger, namespace: str) -> None:

    await ledger.record(namespace, [Material(url=VIDEO, kind="video")])

    assert await ledger.lookup(namespace, "https://cdn.test/ref") is None


async def test_lookup_is_scoped_to_the_namespace(ledger: PgMaterialLedger, namespace: str) -> None:
    await ledger.record(namespace, [Material(url=VIDEO, kind="video")])

    assert await ledger.lookup(str(uuid.uuid4()), VIDEO) is None


async def test_purge_only_clears_its_own_namespace(
    ledger: PgMaterialLedger, namespace: str
) -> None:
    other = str(uuid.uuid4())
    await ledger.record(namespace, [Material(url=VIDEO, kind="video")])
    await ledger.record(other, [Material(url=VIDEO, kind="video")])

    await ledger.purge_namespace(namespace)

    assert await ledger.lookup(namespace, VIDEO) is None
    assert await ledger.lookup(other, VIDEO) is not None


async def test_recording_nothing_is_a_no_op(ledger: PgMaterialLedger, namespace: str) -> None:
    """空素材列表必须跳过 INSERT，避免生成缺少 VALUES 的无效语句。"""

    await ledger.record(namespace, [])

    assert await ledger.lookup(namespace, VIDEO) is None
