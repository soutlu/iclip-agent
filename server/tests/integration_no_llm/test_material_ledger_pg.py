"""PgMaterialLedger 对真实 Postgres 的验收。

三件事只有真库证得了：重记同一个地址走的是 ON CONFLICT 而不是报错、查一条是逐字
比对（前缀不算命中）、清空只碰自己的命名空间。
"""

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
    """同一个地址反复登记是常态（取帧复用既有账本就会再记一遍），不能报错也不能改原行。"""

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
    """同一张图在一条消息里发两次就是这个形状；一条语句里出现两次不能把整条打回。"""

    await ledger.record(
        namespace, [Material(url=IMAGE, kind="image"), Material(url=IMAGE, kind="image")]
    )

    assert await ledger.lookup(namespace, IMAGE) == Material(url=IMAGE, kind="image")


async def test_lookup_matches_the_whole_url(ledger: PgMaterialLedger, namespace: str) -> None:
    """逐字比对：合法地址的前缀不算命中。"""

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
    """纯文字的消息一条素材都没有；不带 VALUES 的 INSERT 是语法错误，所以这条路不发语句。"""

    await ledger.record(namespace, [])

    assert await ledger.lookup(namespace, VIDEO) is None
