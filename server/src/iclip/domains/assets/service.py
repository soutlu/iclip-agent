"""素材签名、登记与外部媒体转存。

直传前由服务端分配 assetId，签名过程不保存状态；登记信息从桶中读取。
外部媒体经下载校验并转存后登记，仅持久化本系统的 object key。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import httpx

from iclip.common.errors import Conflict, NotFound, ValidationFailed
from iclip.domains.assets.images import check_dimensions, check_image_bytes
from iclip.domains.assets.models import (
    IMPORT_NAMESPACE,
    MAX_BYTES,
    UPLOAD_TYPES,
    Asset,
    AssetType,
    UploadTicket,
)
from iclip.domains.assets.repository import AssetRepository
from iclip.domains.assets.schemas import MAX_LIST_LIMIT, UploadSignIn
from iclip.domains.identity.public import Principal
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.oss import SIGNED_PUT_EXPIRES_SECONDS, PublicBucket

_IMPORT_TIMEOUT_SECONDS = 60.0
_READ_CEILING = max(MAX_BYTES.values())


class AssetService:
    """素材上传与查询用例。"""

    def __init__(self, repo: AssetRepository, objects: PublicBucket) -> None:
        self._repo = repo
        self._objects = objects

    def sign_upload(self, body: UploadSignIn) -> UploadTicket:

        asset_type, ext, normalized = _accepted_type(body.content_type)
        if asset_type == "image":
            if body.width is None or body.height is None:
                raise ValidationFailed("传图要报宽高")
            check_dimensions(body.width, body.height)
        asset_id = uuid.uuid4()
        upload_url = self._objects.sign_put(
            object_key=MEDIA_PATHS.upload(asset_id=asset_id, ext=ext),
            content_type=normalized,
        )
        return UploadTicket(
            asset_id=asset_id,
            upload_url=upload_url,
            content_type=normalized,
            # 仅向客户端展示签名有效期，不用于持久化或业务判断。
            expires_at=datetime.now(UTC) + timedelta(seconds=SIGNED_PUT_EXPIRES_SECONDS),
        )

    async def register(self, principal: Principal, asset_id: uuid.UUID) -> Asset:
        """从桶中读取对象信息并登记；重复调用返回同一条记录。"""

        found = await self._objects.find_object(prefix=MEDIA_PATHS.upload_prefix(asset_id=asset_id))
        if found is None:
            raise Conflict("这份素材还没传上来，传完再登记")
        known = UPLOAD_TYPES.get(found.content_type)
        if known is None:
            raise ValidationFailed(f"桶里那个对象的类型是 {found.content_type}，不在收的范围内")
        asset_type: AssetType = known[0]
        if found.size_bytes > MAX_BYTES[asset_type]:
            limit_mb = MAX_BYTES[asset_type] // (1024 * 1024)
            raise ValidationFailed(f"超过 {limit_mb}MB 上限，这份素材不登记")
        return await self._repo.register(
            Asset(
                id=asset_id,
                creator_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                asset_type=asset_type,
                object_key=found.object_key,
                content_type=found.content_type,
                size_bytes=found.size_bytes,
                # 仓储使用数据库 now() 覆盖此占位值。
                created_at=datetime.now(UTC),
            )
        )

    async def import_from_url(self, principal: Principal, source_url: str) -> Asset:
        """转存并登记外部媒体。源地址派生固定 id，重复调用不下载；上游原址更新不覆盖已存素材。"""

        asset_id = uuid.uuid5(IMPORT_NAMESPACE, source_url)
        already = await self._already_imported(asset_id)
        if already is not None:
            return already

        content, content_type = await _download(source_url)
        asset_type, ext, normalized = _accepted_type(content_type)
        if len(content) > MAX_BYTES[asset_type]:
            limit_mb = MAX_BYTES[asset_type] // (1024 * 1024)
            raise ValidationFailed(f"这个地址上的东西超过 {limit_mb}MB 上限，不转存")
        if asset_type == "image":
            check_image_bytes(content)

        object_key = MEDIA_PATHS.upload(asset_id=asset_id, ext=ext)
        await self._objects.put_public_object(
            object_key=object_key, content=content, content_type=normalized
        )
        return await self._repo.register(
            Asset(
                id=asset_id,
                creator_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                asset_type=asset_type,
                object_key=object_key,
                content_type=normalized,
                size_bytes=len(content),
                created_at=datetime.now(UTC),
            )
        )

    async def _already_imported(self, asset_id: uuid.UUID) -> Asset | None:

        try:
            return await self._repo.get(asset_id)
        except NotFound:
            return None

    async def get(self, asset_id: uuid.UUID) -> Asset:
        return await self._repo.get(asset_id)

    async def list_recent(
        self,
        *,
        creator_user_id: uuid.UUID | None = None,
        asset_type: AssetType | None = None,
        limit: int,
    ) -> tuple[Asset, ...]:
        return await self._repo.list_recent(
            creator_user_id=creator_user_id,
            asset_type=asset_type,
            limit=min(limit, MAX_LIST_LIMIT),
        )

    def public_url(self, asset: Asset) -> str:

        return self._objects.public_url(asset.object_key)


def _accepted_type(content_type: str) -> tuple[AssetType, str, str]:
    """返回标准 MIME 类型对应的素材种类、扩展名和 MIME 类型；不支持的类型抛 ValidationFailed。"""

    normalized = content_type.split(";")[0].strip().lower()
    known = UPLOAD_TYPES.get(normalized)
    if known is None:
        allowed = "、".join(sorted(UPLOAD_TYPES))
        raise ValidationFailed(f"不收 {normalized or '空'} 这个类型，只收：{allowed}")
    return known[0], known[1], normalized


async def _download(source_url: str) -> tuple[bytes, str]:
    """下载媒体及其 Content-Type，不跟随重定向，避免扩大源地址范围。"""

    chunks: list[bytes] = []
    read = 0
    try:
        async with (
            httpx.AsyncClient(timeout=_IMPORT_TIMEOUT_SECONDS) as client,
            client.stream("GET", source_url) as response,
        ):
            response.raise_for_status()
            content_type = response.headers.get("content-type") or ""
            async for chunk in response.aiter_bytes():
                read += len(chunk)
                # 流式限制总读取量，避免无界内存占用；调用方再校验具体类型的上限。
                if read > _READ_CEILING:
                    raise ValidationFailed(f"这个地址上的东西太大了：{source_url}")
                chunks.append(chunk)
    except httpx.HTTPError as exc:
        raise ValidationFailed(f"这个地址取不回来：{source_url}") from exc
    return b"".join(chunks), content_type


__all__ = ["AssetService"]
