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
    """路由的类型写 ``Any``（同 identity / conversations）：装配单元不该把 web 框架拖进这一环。"""

    service: CollectionService


def build_collections_module(repo: CollectionRepository) -> CollectionsModule:
    """装配 collections。仓储由组合根给（同 conversations 的套路）。"""

    service = CollectionService(repo)
    return CollectionsModule(routers=(create_collections_router(service),), service=service)


__all__ = ["CollectionsModule", "build_collections_module"]
