"""collections 装配单元：组合根只调用 ``build_collections_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.collections.api import create_collections_router
from iclip.domains.collections.repository import CollectionRepository
from iclip.domains.collections.service import CollectionService


@dataclass(frozen=True)
class CollectionsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: CollectionService


def build_collections_module(repo: CollectionRepository) -> CollectionsModule:

    service = CollectionService(repo)
    return CollectionsModule(routers=(create_collections_router(service),), service=service)


__all__ = ["CollectionsModule", "build_collections_module"]
