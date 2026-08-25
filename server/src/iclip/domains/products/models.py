"""产品资料的领域形状。

**码和名字分开放**：码来自上游、永远有；名字来自本仓的对照表（见 ``tables.py``），
上游新增一个码时名字就是 ``None``。空着看得见，猜错看不见。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Brand:
    code: str | None
    name: str | None


@dataclass(frozen=True, slots=True)
class Category:
    id: int | None
    code: str | None
    name: str | None
    en: str | None


@dataclass(frozen=True, slots=True)
class ColorGroup:
    code: str
    name: str | None


@dataclass(frozen=True, slots=True)
class Color:
    code: str
    name: str
    group: ColorGroup | None
    rgb: str | None


@dataclass(frozen=True, slots=True)
class ProductImage:
    """一张产品图。``width``/``height`` 来自上游的转存记录，可能没量到。"""

    id: str
    url: str
    width: int | None
    height: int | None


@dataclass(frozen=True, slots=True)
class Product:
    """一个款的资料快照。

    ``style_no`` 是 PDM 款号（本接口的查询键），``style_wms`` 是同一个款在 WMS 那
    边的编号——两套编码不通用，爆款视频库认的是后者。
    """

    style_no: str
    style_wms: str | None
    status: str
    dev_year: str | None
    brand: Brand
    category: Category
    combat_team: str | None
    colors: tuple[Color, ...]
    images: tuple[ProductImage, ...]


__all__ = ["Brand", "Category", "Color", "ColorGroup", "Product", "ProductImage"]
