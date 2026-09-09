"""外部 PDM 同步库的只读查询，不建表、不迁移、不写入。

只解析款的品类与品牌归属；产品资料查询（图片、颜色、名称）已下线，相应的多表
聚合与编码到名称的对照表一并移除。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.products.models import StyleGrouping

_BRAND_CODE: Final = "replace(attributes::text, '\\u0000', '')::json ->> 'brand'"
"""上游有款把 ``\\u0000`` 写进了 attributes；json 存得下，取成 text 却会整条查询
报错，所以取值前先剔除。"""

_RESOLVE_GROUPING: Final = text(f"""
SELECT product_number, product_category_id, {_BRAND_CODE} AS brand_code
FROM pdm_styles
WHERE product_number = ANY(:style_nos) AND is_active AND NOT is_source_deleted
""")


def _blank_to_none(value: str | None) -> str | None:
    """将上游空字符串视为缺失值。"""

    return value.strip() or None if value else None


class PgStyleDirectory:
    """按 PDM 款号批量解析品类与品牌归属。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def resolve(self, style_nos: Sequence[str]) -> Mapping[str, StyleGrouping]:
        """查不到的款、以及品类或品牌缺失的款，都不出现在结果里。

        缺归属不是错误：使用方据此判断这个款无从圈选同类款，自行决定怎么处理。
        """

        if not style_nos:
            return {}
        async with self._engine.connect() as conn:
            rows = (
                (await conn.execute(_RESOLVE_GROUPING, {"style_nos": list(style_nos)}))
                .mappings()
                .all()
            )
        found: dict[str, StyleGrouping] = {}
        for row in rows:
            brand_code = _blank_to_none(row["brand_code"])
            if row["product_category_id"] is None or brand_code is None:
                continue
            found[row["product_number"]] = StyleGrouping(
                category_id=row["product_category_id"], brand_code=brand_code
            )
        return found


__all__ = ["PgStyleDirectory"]
