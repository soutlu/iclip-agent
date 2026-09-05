"""inspirations 装配单元：组合根只调用 ``build_inspirations_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.inspirations.api import create_inspirations_router
from iclip.domains.inspirations.catalog_pg import PgInspirationCatalog


@dataclass(frozen=True, slots=True)
class InspirationsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    catalog: PgInspirationCatalog


def build_inspirations_module(catalog: PgInspirationCatalog) -> InspirationsModule:

    return InspirationsModule(routers=(create_inspirations_router(catalog),), catalog=catalog)


__all__ = ["InspirationsModule", "build_inspirations_module"]
