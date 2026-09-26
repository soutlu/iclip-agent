"""直传签名与确认。签名本地算；确认从桶里读，通过后记一条上传记录。

上传者与 API key 照旧签进 ``x-oss-meta-*`` 请求头随对象存在桶里；记录的属主是确认时的主体。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Final, Protocol

from iclip.common.errors import Conflict, ValidationFailed
from iclip.domains.identity.public import Principal
from iclip.domains.uploads.models import (
    MAX_BYTES,
    MAX_LONG_EDGE_PIXELS,
    MIN_SHORT_EDGE_PIXELS,
    UPLOAD_TYPES,
    ConfirmedUpload,
    MediaKind,
    UploadTicket,
)
from iclip.domains.uploads.schemas import UploadSignIn
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import SIGNED_PUT_EXPIRES_SECONDS, SignedUploadStore

UPLOADER_HEADER: Final = "x-oss-meta-uploader"
API_KEY_HEADER: Final = "x-oss-meta-api-key"
"""随对象存进桶的审计元数据：值是 UUID 文本，OSS 只收 ASCII。"""


class RecordUpload(Protocol):
    """把一次确认过的上传记成一条记录；行 id 就是 ``upload_id``，重复调用不重复落行、不改已有的。
    实现由组合根接到生成域。"""

    async def __call__(
        self, principal: Principal, *, upload_id: uuid.UUID, kind: MediaKind, url: str
    ) -> None: ...


class UploadService:
    """直传的两个用例：签许可、按桶确认并记录。"""

    def __init__(self, objects: SignedUploadStore, *, record: RecordUpload) -> None:
        self._objects = objects
        self._record = record

    def sign_upload(self, principal: Principal, body: UploadSignIn) -> UploadTicket:
        kind, ext, normalized = _accepted_type(body.content_type)
        if kind == "image":
            if body.width is None or body.height is None:
                raise ValidationFailed("传图要报宽高")
            _check_dimensions(body.width, body.height)
        headers = {"Content-Type": normalized, UPLOADER_HEADER: str(principal.user_id)}
        if principal.api_key_id is not None:
            headers[API_KEY_HEADER] = str(principal.api_key_id)
        upload_id = uuid.uuid4()
        upload_url = self._objects.sign_put(
            object_key=MEDIA_PATHS.upload(upload_id=upload_id, ext=ext), headers=headers
        )
        return UploadTicket(
            upload_id=upload_id,
            upload_url=upload_url,
            headers=headers,
            # 仅向客户端展示签名有效期，不用于业务判断。
            expires_at=datetime.now(UTC) + timedelta(seconds=SIGNED_PUT_EXPIRES_SECONDS),
        )

    async def confirm(self, principal: Principal, upload_id: uuid.UUID) -> ConfirmedUpload:
        """按桶里的对象核对类型与大小，通过后以 ``principal`` 记一条上传，交回地址。

        每次都重新按桶回答，可重复调；记录按 ``upload_id`` 幂等，第二次不改属主。核对不过
        （``Conflict`` / ``ValidationFailed``）不记录。"""

        found = await self._objects.find_object(
            prefix=MEDIA_PATHS.upload_prefix(upload_id=upload_id)
        )
        if found is None:
            raise Conflict("这个文件还没传上来，传完再确认")
        known = UPLOAD_TYPES.get(found.content_type)
        if known is None:
            raise ValidationFailed(f"桶里那个对象的类型是 {found.content_type}，不在收的范围内")
        kind: MediaKind = known[0]
        if found.size_bytes > MAX_BYTES[kind]:
            limit_mb = MAX_BYTES[kind] // (1024 * 1024)
            raise ValidationFailed(f"超过 {limit_mb}MB 上限，这个文件不能用")
        url = self._objects.public_url(found.object_key)
        await self._record(principal, upload_id=upload_id, kind=kind, url=url)
        return ConfirmedUpload(
            url=url, content_type=found.content_type, size_bytes=found.size_bytes
        )


def _accepted_type(content_type: str) -> tuple[MediaKind, str, str]:
    """返回标准 MIME 类型对应的媒体种类、扩展名和 MIME 类型；不支持的类型抛 ValidationFailed。"""

    normalized = content_type.split(";")[0].strip().lower()
    known = UPLOAD_TYPES.get(normalized)
    if known is None:
        allowed = "、".join(sorted(UPLOAD_TYPES))
        raise ValidationFailed(f"不收 {normalized or '空'} 这个类型，只收：{allowed}")
    return known[0], known[1], normalized


def _check_dimensions(width: int, height: int) -> None:
    """按短边和长边校验客户端申报的尺寸，超限抛 ValidationFailed。"""

    if min(width, height) < MIN_SHORT_EDGE_PIXELS:
        raise ValidationFailed(
            f"{width}×{height} 的短边不到 {MIN_SHORT_EDGE_PIXELS}px，这张图太小了"
        )
    if max(width, height) > MAX_LONG_EDGE_PIXELS:
        raise ValidationFailed(
            f"{width}×{height} 的长边超过 {MAX_LONG_EDGE_PIXELS}px，先缩一下再传"
        )


__all__ = ["API_KEY_HEADER", "UPLOADER_HEADER", "RecordUpload", "UploadService"]
