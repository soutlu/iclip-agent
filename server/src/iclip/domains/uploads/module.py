"""uploads 装配单元：组合根只调用 ``build_uploads_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.identity.public import ActAs
from iclip.domains.uploads.api import create_uploads_router
from iclip.domains.uploads.service import RecordUpload, UploadService
from iclip.platform.object_store.store import SignedUploadStore


@dataclass(frozen=True)
class UploadsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: UploadService


def build_uploads_module(
    objects: SignedUploadStore, *, act_as: ActAs, record: RecordUpload
) -> UploadsModule:
    """``record`` 把确认过的上传记成一条记录，由组合根接到生成域。"""

    service = UploadService(objects, record=record)
    return UploadsModule(routers=(create_uploads_router(service, act_as=act_as),), service=service)


__all__ = ["UploadsModule", "build_uploads_module"]
