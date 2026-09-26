"""外部 PDM 同步库的替身表：建表与登记款，供款目录与爆款视频查询测试共用。"""

from __future__ import annotations

from typing import Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

_RECREATE: Final = """
DROP TABLE IF EXISTS pdm_styles CASCADE;
CREATE TABLE pdm_styles (
    pdm_entity_id       bigint PRIMARY KEY,
    product_number      varchar NOT NULL,
    style_wms           varchar,
    source_status       varchar NOT NULL,
    product_category_id bigint,
    brand               varchar,
    attributes          json    NOT NULL DEFAULT '{}'::json,
    is_active           boolean NOT NULL DEFAULT true,
    is_source_deleted   boolean NOT NULL DEFAULT false
);
"""

_INSERT_STYLE = text(
    "INSERT INTO pdm_styles"
    " (pdm_entity_id, product_number, style_wms, source_status, product_category_id,"
    "  brand, is_active, is_source_deleted)"
    " VALUES (:entity_id, :style_no, :style_no, 'effective', :category_id,"
    "         :brand_code, :is_active, :deleted)"
)


async def recreate_pdm_styles(engine: AsyncEngine) -> None:
    """删掉重建替身表，每条用例从空表起步。"""

    async with engine.begin() as conn:
        for statement in filter(None, (part.strip() for part in _RECREATE.split(";"))):
            await conn.execute(text(statement))


async def seed_pdm_style(
    engine: AsyncEngine,
    *,
    style_no: str,
    category_id: int | None = 70,
    brand_code: str | None = "3",
    entity_id: int | None = None,
    is_active: bool = True,
    deleted: bool = False,
) -> None:
    """登记一个款的品类与品牌归属。``None`` 表示上游缺这一项；不给 ``entity_id`` 就按款号推一个。"""

    async with engine.begin() as conn:
        await conn.execute(
            _INSERT_STYLE,
            {
                "entity_id": entity_id if entity_id is not None else abs(hash(style_no)) % 10**9,
                "style_no": style_no,
                "category_id": category_id,
                "brand_code": brand_code,
                "is_active": is_active,
                "deleted": deleted,
            },
        )


__all__ = ["recreate_pdm_styles", "seed_pdm_style"]
