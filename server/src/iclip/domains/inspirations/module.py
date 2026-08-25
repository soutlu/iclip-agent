"""inspirations 装配单元：组合根只调用 ``build_inspirations_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.inspirations.api import create_inspirations_router
from iclip.domains.inspirations.catalog_pg import PgInspirationCatalog


@dataclass(frozen=True, slots=True)
class InspirationsModule:
    routers: tuple[Any, ...]
    """路由的类型写 ``Any``（同 identity / products）：装配单元不该把 web 框架拖进这一环。"""

    catalog: PgInspirationCatalog


def build_inspirations_module(catalog: PgInspirationCatalog) -> InspirationsModule:
    """装配 inspirations。爆款库的连接由组合根给（同 products 收 catalog 的套路）。"""

    return InspirationsModule(routers=(create_inspirations_router(catalog),), catalog=catalog)


__all__ = ["InspirationsModule", "build_inspirations_module"]
