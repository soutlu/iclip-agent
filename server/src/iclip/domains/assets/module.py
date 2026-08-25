"""assets 装配单元：组合根只调用 ``build_assets_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.assets.api import create_assets_router, create_uploads_router
from iclip.domains.assets.repository import AssetRepository
from iclip.domains.assets.service import AssetService
from iclip.platform.object_store.oss import SignedUploadStore


@dataclass(frozen=True)
class AssetsModule:
    routers: tuple[Any, ...]
    """路由的类型写 ``Any``（同 identity / conversations / generation）：装配单元不该
    把 web 框架拖进这一环。"""

    service: AssetService


def build_assets_module(repo: AssetRepository, objects: SignedUploadStore) -> AssetsModule:
    """装配 assets。它要一张自己的表和那个公开桶，不依赖任何别的业务模块。"""

    service = AssetService(repo, objects)
    return AssetsModule(
        routers=(create_uploads_router(service), create_assets_router(service)),
        service=service,
    )


__all__ = ["AssetsModule", "build_assets_module"]
