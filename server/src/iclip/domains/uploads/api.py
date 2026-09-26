"""直传的 HTTP 端点：签许可、按桶确认。两步都需要 ``uploads:write``。"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter

from iclip.domains.identity.public import ActAs, Principal, require_permission
from iclip.domains.uploads.schemas import (
    UploadConfirmedOut,
    UploadConfirmIn,
    UploadSignIn,
    UploadTicketOut,
    confirmed_out,
    ticket_out,
)
from iclip.domains.uploads.service import UploadService


def create_uploads_router(service: UploadService, *, act_as: ActAs) -> APIRouter:
    router = APIRouter(prefix="/uploads", tags=["uploads"])

    @router.post("/sign", response_model=UploadTicketOut)
    async def sign_upload(
        body: UploadSignIn,
        principal: Annotated[Principal, require_permission("uploads:write")],
    ) -> UploadTicketOut:
        """发一条限时直传地址；上传者与 key 一起签进请求头，随对象存进桶。"""

        return ticket_out(service.sign_upload(principal, body))

    @router.post("/{upload_id}/confirm", response_model=UploadConfirmedOut)
    async def confirm_upload(
        upload_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("uploads:write")],
        body: UploadConfirmIn | None = None,
    ) -> UploadConfirmedOut:
        """按桶里的对象核对类型与大小，通过后记一条上传记录（id 就是 ``uploadId``），交回地址。

        请求体可选，只有 ``userName``：给了按替人办事换主体（浏览器只能写自己），不给就记在当前
        主体名下。可重复调：每次都按桶重新核对，返回同一条记录，第二次的 ``userName`` 不改属主。
        """

        principal = await act_as(principal, body.user_name if body is not None else None)
        return confirmed_out(await service.confirm(principal, upload_id))

    return router


__all__ = ["create_uploads_router"]
