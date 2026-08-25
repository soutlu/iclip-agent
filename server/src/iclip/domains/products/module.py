"""products 装配单元：组合根只调用 ``build_products_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.products.api import create_products_router
from iclip.domains.products.catalog_pg import PgProductCatalog


@dataclass(frozen=True, slots=True)
class ProductsModule:
    routers: tuple[Any, ...]
    """路由的类型写 ``Any``（同 identity / conversations）：装配单元不该把 web 框架拖进这一环。"""

    catalog: PgProductCatalog


def build_products_module(catalog: PgProductCatalog) -> ProductsModule:
    """装配 products。

    目录库的连接与产品图的桶前缀都由组合根给（同 conversations 收 repository 的
    套路）——它们是环境的事实，这一环不该认识环境。
    """

    return ProductsModule(routers=(create_products_router(catalog),), catalog=catalog)


__all__ = ["ProductsModule", "build_products_module"]
