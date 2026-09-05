"""产品资料领域模型。保留上游编码，名称由 tables.py 映射；未知编码对应名称为 None。"""

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
    """产品资料快照。style_no 为 PDM 查询键，style_wms 为爆款视频查询使用的 WMS 编号，两者不可互换。"""

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
