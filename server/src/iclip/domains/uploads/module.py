"""uploads 装配单元：组合根只调用 ``build_uploads_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.uploads.api import create_uploads_router
from iclip.domains.uploads.service import UploadService
from iclip.platform.object_store.oss import SignedUploadStore


@dataclass(frozen=True)
class UploadsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: UploadService


def build_uploads_module(objects: SignedUploadStore) -> UploadsModule:
    service = UploadService(objects)
    return UploadsModule(routers=(create_uploads_router(service),), service=service)


__all__ = ["UploadsModule", "build_uploads_module"]
