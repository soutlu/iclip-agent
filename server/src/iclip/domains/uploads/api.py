"""把浏览器里的一个文件变成一个公网地址。本仓唯一的上传口。

**没有素材账本**：不发 id、不记归属，产物就是那个地址，谁引用谁自己记。

**同内容同地址**：对象 key 由内容的 SHA-256 派生，重复上传天然幂等。
"""

from __future__ import annotations

import hashlib
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from iclip.common.errors import ValidationFailed
from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.uploads.schemas import (
    EXTENSION_BY_CONTENT_TYPE,
    MAX_UPLOAD_BYTES,
    UploadEnvelope,
    UploadOut,
)
from iclip.platform.object_store.oss import ObjectStoreUnavailable, PublicObjectStore

_OSS_PREFIX = "uploads"
_READ_CHUNK_BYTES = 1024 * 1024


def create_uploads_router(store: PublicObjectStore) -> APIRouter:
    router = APIRouter(prefix="/uploads", tags=["uploads"])

    @router.post("", response_model=UploadEnvelope, status_code=201)
    async def upload_file(
        _: Annotated[Principal, Depends(require_permission("assets:write"))],
        file: Annotated[UploadFile, File()],
    ) -> UploadEnvelope:
        content_type = (file.content_type or "").split(";")[0].strip().lower()
        extension = EXTENSION_BY_CONTENT_TYPE.get(content_type)
        if extension is None:
            raise ValidationFailed(f"不收这个类型的文件：{content_type or '未声明'}")

        content = await _read_capped(file)
        digest = hashlib.sha256(content).hexdigest()
        try:
            url = await store.put_public_object(
                object_key=f"{_OSS_PREFIX}/{digest}.{extension}",
                content=content,
                content_type=content_type,
            )
        except ObjectStoreUnavailable as exc:
            # 502 而不是 500：写不进去是存储那边的事，不是这次请求有毛病。分开报，
            # 用户才知道该重试还是该改文件。
            raise HTTPException(status_code=502, detail=f"对象存储写入失败：{exc}") from exc
        return UploadEnvelope(upload=UploadOut(url=url, content_type=content_type))

    return router


async def _read_capped(file: UploadFile) -> bytes:
    """读完整个文件，超上限就在读到那一刻停手。

    分块读而不是一把 ``read()``：一把读的话，超限这件事要等超出的字节也进了内存才
    发现，那时候拒绝已经没有意义了。
    """

    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(_READ_CHUNK_BYTES):
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise ValidationFailed(f"文件超过 {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB 上限")
        chunks.append(chunk)
    if total == 0:
        raise ValidationFailed("文件是空的")
    return b"".join(chunks)


__all__ = ["create_uploads_router"]
