"""inspirations 装配单元：组合根只调用 ``build_inspirations_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.inspirations.api import create_inspirations_router
from iclip.domains.inspirations.infra_sql import PgInspirationVideos
from iclip.domains.inspirations.service import InspirationService
from iclip.domains.products.public import StyleDirectory


@dataclass(frozen=True, slots=True)
class InspirationsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: InspirationService


def build_inspirations_module(
    videos: PgInspirationVideos, styles: StyleDirectory
) -> InspirationsModule:
    """仓储与产品资料目录由组合根注入。"""

    service = InspirationService(videos, styles)
    return InspirationsModule(routers=(create_inspirations_router(service),), service=service)


__all__ = ["InspirationsModule", "build_inspirations_module"]
