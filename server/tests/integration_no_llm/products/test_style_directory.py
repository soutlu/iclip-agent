"""验证 PDM 款目录的批量归属解析：过滤规则、缺失处理与脏数据容错。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.domains.products.catalog_pg import PgStyleDirectory
from tests.helpers.pdm import PDM_STYLES_DDL

_DDL = f"""
DROP TABLE IF EXISTS pdm_styles CASCADE;
{PDM_STYLES_DDL}
"""

_INSERT = text(
    "INSERT INTO pdm_styles"
    " (pdm_entity_id, product_number, style_wms, source_status, product_category_id,"
    "  attributes, is_active, is_source_deleted)"
    " VALUES (:entity_id, :style_no, :style_no, 'effective', :category_id,"
    "         cast(:attributes as json), :is_active, :deleted)"
)


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = create_async_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            for statement in filter(None, (part.strip() for part in _DDL.split(";"))):
                await conn.execute(text(statement))
        yield engine
    finally:
        await engine.dispose()


async def seed(
    engine: AsyncEngine,
    *,
    style_no: str,
    entity_id: int,
    category_id: int | None = 70,
    attributes: str = '{"brand": "3"}',
    is_active: bool = True,
    deleted: bool = False,
) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            _INSERT,
            {
                "entity_id": entity_id,
                "style_no": style_no,
                "category_id": category_id,
                "attributes": attributes,
                "is_active": is_active,
                "deleted": deleted,
            },
        )


async def test_resolves_category_and_brand(engine: AsyncEngine) -> None:
    await seed(engine, style_no="SNMT241M", entity_id=1)

    found = await PgStyleDirectory(engine).resolve(["SNMT241M"])

    assert found["SNMT241M"].category_id == 70
    assert found["SNMT241M"].brand_code == "3"


async def test_unknown_style_is_absent_not_an_error(engine: AsyncEngine) -> None:
    found = await PgStyleDirectory(engine).resolve(["NOPE"])

    assert found == {}


async def test_empty_input_skips_the_query(engine: AsyncEngine) -> None:
    assert await PgStyleDirectory(engine).resolve([]) == {}


async def test_inactive_and_deleted_styles_are_invisible(engine: AsyncEngine) -> None:
    await seed(engine, style_no="GONE", entity_id=2, is_active=False)
    await seed(engine, style_no="DELETED", entity_id=3, deleted=True)

    found = await PgStyleDirectory(engine).resolve(["GONE", "DELETED"])

    assert found == {}


async def test_missing_grouping_is_dropped(engine: AsyncEngine) -> None:
    """缺品类或缺品牌的款圈选不出同类款，不返回半个归属。"""

    await seed(engine, style_no="NO-CATEGORY", entity_id=4, category_id=None)
    await seed(engine, style_no="NO-BRAND", entity_id=5, attributes="{}")
    await seed(engine, style_no="BLANK-BRAND", entity_id=6, attributes='{"brand": "  "}')

    found = await PgStyleDirectory(engine).resolve(["NO-CATEGORY", "NO-BRAND", "BLANK-BRAND"])

    assert found == {}


async def test_null_byte_in_attributes_does_not_break_the_query(engine: AsyncEngine) -> None:
    """上游把 \\u0000 写进了 attributes：json 存得下，取成 text 会整条查询报错。"""

    await seed(
        engine,
        style_no="DIRTY",
        entity_id=7,
        attributes='{"development_year": "\\u00002\\u00004", "brand": "1"}',
    )

    found = await PgStyleDirectory(engine).resolve(["DIRTY"])

    assert found["DIRTY"].brand_code == "1"


async def test_resolves_a_batch_in_one_call(engine: AsyncEngine) -> None:
    await seed(engine, style_no="A", entity_id=8, category_id=70)
    await seed(engine, style_no="B", entity_id=9, category_id=88, attributes='{"brand": "1"}')

    found = await PgStyleDirectory(engine).resolve(["A", "B", "MISSING"])

    assert set(found) == {"A", "B"}
    assert (found["B"].category_id, found["B"].brand_code) == (88, "1")
