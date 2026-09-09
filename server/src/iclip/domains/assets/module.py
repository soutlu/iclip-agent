"""assets 装配单元：组合根只调用 ``build_assets_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.assets.api import create_assets_router, create_uploads_router
from iclip.domains.assets.repository import AssetRepository
from iclip.domains.assets.service import AssetService
from iclip.platform.object_store.oss import PublicBucket


@dataclass(frozen=True)
class AssetsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: AssetService


def build_assets_module(repo: AssetRepository, objects: PublicBucket) -> AssetsModule:

    service = AssetService(repo, objects)
    return AssetsModule(
        routers=(create_uploads_router(service), create_assets_router(service)),
        service=service,
    )


__all__ = ["AssetsModule", "build_assets_module"]
