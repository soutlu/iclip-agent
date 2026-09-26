"""验证 PDM 款目录的批量归属解析、有效行过滤与归属缺失处理。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.domains.products.catalog_pg import PgStyleDirectory
from tests.helpers.pdm import recreate_pdm_styles, seed_pdm_style


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = create_async_engine(migrated_pg)
    try:
        await recreate_pdm_styles(engine)
        yield engine
    finally:
        await engine.dispose()


async def test_resolves_category_and_brand(engine: AsyncEngine) -> None:
    """品牌来自独立列，attributes 保留新库的空对象形状。"""

    await seed_pdm_style(engine, style_no="SNMT241M", entity_id=1)

    found = await PgStyleDirectory(engine).resolve(["SNMT241M"])

    assert found["SNMT241M"].category_id == 70
    assert found["SNMT241M"].brand_code == "3"


async def test_unknown_style_is_absent_not_an_error(engine: AsyncEngine) -> None:
    found = await PgStyleDirectory(engine).resolve(["NOPE"])

    assert found == {}


async def test_empty_input_skips_the_query(engine: AsyncEngine) -> None:
    assert await PgStyleDirectory(engine).resolve([]) == {}


async def test_inactive_and_deleted_styles_are_invisible(engine: AsyncEngine) -> None:
    await seed_pdm_style(engine, style_no="GONE", entity_id=2, is_active=False)
    await seed_pdm_style(engine, style_no="DELETED", entity_id=3, deleted=True)

    found = await PgStyleDirectory(engine).resolve(["GONE", "DELETED"])

    assert found == {}


async def test_missing_grouping_is_dropped(engine: AsyncEngine) -> None:
    """缺品类或缺品牌的款圈选不出同类款，不返回半个归属。"""

    await seed_pdm_style(engine, style_no="NO-CATEGORY", entity_id=4, category_id=None)
    await seed_pdm_style(engine, style_no="NO-BRAND", entity_id=5, brand_code=None)
    await seed_pdm_style(engine, style_no="EMPTY-BRAND", entity_id=6, brand_code="")
    await seed_pdm_style(engine, style_no="BLANK-BRAND", entity_id=7, brand_code="  ")

    found = await PgStyleDirectory(engine).resolve(
        ["NO-CATEGORY", "NO-BRAND", "EMPTY-BRAND", "BLANK-BRAND"]
    )

    assert found == {}


async def test_resolves_a_batch_in_one_call(engine: AsyncEngine) -> None:
    await seed_pdm_style(engine, style_no="A", entity_id=8, category_id=70)
    await seed_pdm_style(engine, style_no="B", entity_id=9, category_id=88, brand_code="1")

    found = await PgStyleDirectory(engine).resolve(["A", "B", "MISSING"])

    assert set(found) == {"A", "B"}
    assert (found["B"].category_id, found["B"].brand_code) == (88, "1")
