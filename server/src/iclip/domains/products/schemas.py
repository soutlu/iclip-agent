"""产品资料的 wire 形状。字段名按跨端约定用 camelCase。"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from iclip.domains.products.models import Product


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class BrandOut(CamelModel):
    code: str | None
    name: str | None


class CategoryOut(CamelModel):
    id: int | None
    code: str | None
    name: str | None
    en: str | None


class ColorGroupOut(CamelModel):
    code: str
    name: str | None


class ColorOut(CamelModel):
    code: str
    name: str
    group: ColorGroupOut | None
    rgb: str | None


class ImageOut(CamelModel):
    id: str
    url: str
    width: int | None
    height: int | None


class ProductOut(CamelModel):
    """``styleWms`` 给调用方拿去查爆款视频——那边认的是 WMS 编号，不是 PDM 款号。"""

    style_no: str
    style_wms: str | None
    status: str
    dev_year: str | None
    brand: BrandOut
    category: CategoryOut
    combat_team: str | None
    colors: list[ColorOut]
    images: list[ImageOut]


class ProductEnvelope(CamelModel):
    product: ProductOut


def product_out(product: Product) -> ProductOut:
    """领域形状 → wire 形状。"""

    return ProductOut(
        style_no=product.style_no,
        style_wms=product.style_wms,
        status=product.status,
        dev_year=product.dev_year,
        brand=BrandOut(code=product.brand.code, name=product.brand.name),
        category=CategoryOut(
            id=product.category.id,
            code=product.category.code,
            name=product.category.name,
            en=product.category.en,
        ),
        combat_team=product.combat_team,
        colors=[
            ColorOut(
                code=color.code,
                name=color.name,
                group=(
                    ColorGroupOut(code=color.group.code, name=color.group.name)
                    if color.group is not None
                    else None
                ),
                rgb=color.rgb,
            )
            for color in product.colors
        ],
        images=[
            ImageOut(id=image.id, url=image.url, width=image.width, height=image.height)
            for image in product.images
        ],
    )


__all__ = [
    "BrandOut",
    "CategoryOut",
    "ColorGroupOut",
    "ColorOut",
    "ImageOut",
    "ProductEnvelope",
    "ProductOut",
    "product_out",
]
