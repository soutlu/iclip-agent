"""产品资料领域模型。保留上游编码，不在本域翻译成名称。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class StyleGrouping:
    """一个款归属的品类与品牌。

    只保留编码：使用方按这两维圈选同类款，比对的是编码，不展示名称。名称字典在
    上游库里（品类见 ``pdm_product_categories``，品牌的 ``mdm_model_brands``
    目前还是空表），等有对外展示需求时再从那里取，不在本域冻结副本。
    """

    category_id: int
    brand_code: str


__all__ = ["StyleGrouping"]
