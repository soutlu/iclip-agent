"""products 装配单元：组合根只调用 ``build_products_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.products.api import create_products_router
from iclip.domains.products.catalog_pg import PgProductCatalog


@dataclass(frozen=True, slots=True)
class ProductsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    catalog: PgProductCatalog


def build_products_module(catalog: PgProductCatalog) -> ProductsModule:
    """目录连接与图片桶前缀由组合根注入。"""

    return ProductsModule(routers=(create_products_router(catalog),), catalog=catalog)


__all__ = ["ProductsModule", "build_products_module"]
