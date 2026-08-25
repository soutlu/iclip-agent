"""产品资料目录的只读后端：外部 Postgres（PDM 的同步副本）。

**这些表不是我们的。** 本模块不建表、不迁移、不写入，只按显式列名读。上游改结构时
我们会响亮地失败（列名对不上直接报错），而不是悄悄返回半截数据——这正是要的失效
方式。

一个款一次往返：款、图、颜色三段在库里聚成 JSON 再回来。分三条查会是三次往返，而
这个库在网络另一头。

四条不能省的过滤，少一条就会给出错的东西：

- 每一跳都要 ``is_active AND NOT is_source_deleted``——同步副本用标记位表达删除。
- 取图那跳还要 ``is_current AND status = 'succeeded'``：转存失败的行也在表里，用它
  会得到一个指向空对象的地址。
- 图按 ``content_hash`` 去重：同一个款下确实存在多条映射指向同一张图。
- 颜色走 ``style_pdm_id``；``pdm_skcs.style_id`` 那个 UUID 外键列上游还没回填，全是
  NULL，用它一个颜色都查不到而且不报错。
"""

from __future__ import annotations

import json
from typing import Any, Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import NotFound
from iclip.domains.products.models import Color, Product, ProductImage
from iclip.domains.products.tables import brand_for, category_for, color_group_for

PRODUCT_IMAGE_FILE_TYPE: Final = 17
"""上游给产品图用的文件类型码；别的类型是模具图、材料图这些工艺资料。"""

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
    """把聚合出来的那一列还原成行。

    驱动对 ``text()`` 查询里的 json 列不做解码，拿到的是一段字符串。
    """

    if isinstance(value, str):
        return json.loads(value)
    return list(value)


def _blank_to_none(value: str | None) -> str | None:
    """上游的空串等于没填（``style_wms`` 里就有空串）。"""

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
            # 上游同步 style 时没带 CT 归属那一列；等它同步过来这里才有值。
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
