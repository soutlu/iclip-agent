"""外部 PDM 同步库的只读查询，不建表、不迁移、不写入。

款、图片与颜色在单次查询中聚合；每层仅取 is_active 且未被源端删除的记录。
图片仅取当前成功转存记录，并按 content_hash 去重。
颜色通过 style_pdm_id 关联；上游 style_id 未回填，不能作为关联键。"""

from __future__ import annotations

import json
from typing import Any, Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import NotFound
from iclip.domains.products.models import Color, Product, ProductImage
from iclip.domains.products.tables import brand_for, category_for, color_group_for

PRODUCT_IMAGE_FILE_TYPE: Final = 17
"""上游产品图类型码，排除模具图和材料图等工艺资料。"""

_FIND_PRODUCT: Final = text(f"""
WITH style AS (
    SELECT pdm_entity_id, product_number, style_wms, source_status,
           product_category_id,
           attributes ->> 'brand'    AS brand_code,
           attributes ->> 'dev_year' AS dev_year
    FROM pdm_styles
    WHERE product_number = :style_no AND is_active AND NOT is_source_deleted
),
images AS (
    SELECT DISTINCT ON (a.content_hash)
           m.pdm_entity_id AS file_id, a.object_key, a.width, a.height
    FROM style s
    JOIN pdm_file_mappings m
           ON m.business_id = s.pdm_entity_id
          AND m.file_type = {PRODUCT_IMAGE_FILE_TYPE}
          AND m.is_active AND NOT m.is_source_deleted
    JOIN pdm_asset_versions v
           ON v.pdm_file_mapping_id = m.id AND v.is_current AND v.status = 'succeeded'
    JOIN assets a ON a.id = v.asset_id
    ORDER BY a.content_hash, m.pdm_entity_id
),
colors AS (
    SELECT DISTINCT c.color_code, c.display_name,
           c.attributes ->> 'color_group' AS color_group, c.rgb
    FROM style s
    JOIN pdm_skcs k
           ON k.style_pdm_id = s.pdm_entity_id
          AND k.is_active AND NOT k.is_source_deleted
    JOIN pdm_colors c
           ON c.pdm_entity_id = k.color_pdm_id
          AND c.is_active AND NOT c.is_source_deleted
)
SELECT s.product_number, s.style_wms, s.source_status, s.product_category_id,
       s.brand_code, s.dev_year,
       (SELECT coalesce(json_agg(json_build_object(
                   'file_id', file_id, 'object_key', object_key,
                   'width', width, 'height', height) ORDER BY file_id), '[]'::json)
        FROM images) AS images,
       (SELECT coalesce(json_agg(json_build_object(
                   'code', color_code, 'name', display_name,
                   'group', color_group, 'rgb', rgb) ORDER BY color_code), '[]'::json)
        FROM colors) AS colors
FROM style s
""")


def _rows(value: Any) -> list[dict[str, Any]]:
    """解码 text() 查询返回的 JSON 字符串；驱动不自动处理此列。"""

    if isinstance(value, str):
        return json.loads(value)
    return list(value)


def _blank_to_none(value: str | None) -> str | None:
    """将上游空字符串视为缺失值。"""

    return value.strip() or None if value else None


class PgProductCatalog:
    """按 PDM 款号查一个款；查不到即 ``NotFound``。"""

    def __init__(self, engine: AsyncEngine, *, image_base_url: str) -> None:
        self._engine = engine
        self._image_base_url = image_base_url.rstrip("/")

    async def find(self, style_no: str) -> Product:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_FIND_PRODUCT, {"style_no": style_no})).mappings().first()
        if row is None:
            raise NotFound(f"没有款号 {style_no}")
        return Product(
            style_no=row["product_number"],
            style_wms=_blank_to_none(row["style_wms"]),
            status=row["source_status"],
            dev_year=_blank_to_none(row["dev_year"]),
            brand=brand_for(row["brand_code"]),
            category=category_for(row["product_category_id"]),
            # 同步库未提供 CT 归属。
            combat_team=None,
            colors=tuple(
                Color(
                    code=item["code"],
                    name=item["name"],
                    group=color_group_for(item["group"]),
                    rgb=_blank_to_none(item["rgb"]),
                )
                for item in _rows(row["colors"])
            ),
            images=tuple(
                ProductImage(
                    id=str(item["file_id"]),
                    url=f"{self._image_base_url}/{item['object_key']}",
                    width=item["width"],
                    height=item["height"],
                )
                for item in _rows(row["images"])
            ),
        )


__all__ = ["PRODUCT_IMAGE_FILE_TYPE", "PgProductCatalog"]
