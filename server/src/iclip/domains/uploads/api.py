"""直传的 HTTP 端点：签许可、按桶确认。两步都需要 ``uploads:write``。"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.uploads.schemas import (
    UploadConfirmedOut,
    UploadSignIn,
    UploadTicketOut,
    confirmed_out,
    ticket_out,
)
from iclip.domains.uploads.service import UploadService


def create_uploads_router(service: UploadService) -> APIRouter:
    router = APIRouter(prefix="/uploads", tags=["uploads"])

    @router.post("/sign", response_model=UploadTicketOut)
    async def sign_upload(
        body: UploadSignIn,
        principal: Annotated[Principal, Depends(require_permission("uploads:write"))],
    ) -> UploadTicketOut:
        """发一条限时直传地址；上传者与 key 一起签进请求头，随对象存进桶。"""

        return ticket_out(service.sign_upload(principal, body))

    @router.post("/{upload_id}/confirm", response_model=UploadConfirmedOut)
    async def confirm_upload(
        upload_id: uuid.UUID,
        _: Annotated[Principal, Depends(require_permission("uploads:write"))],
    ) -> UploadConfirmedOut:
        """按桶里的对象核对类型与大小，只交回地址。没有请求体，可重复调。"""

        return confirmed_out(await service.confirm(upload_id))

    return router


__all__ = ["create_uploads_router"]
