"""素材上传与账本的用例层。

上传分两步，中间隔着一次浏览器直传：

1. **签名**：服务端发一个 ``assetId``、按它算出 object key、签一条限时的 PUT 地址。
   这一步不落库、不留内存状态——签名之后什么都没发生，客户端拿着地址走了也一样。
2. **登记**：字节已经在桶里了，服务端去桶里核实一遍，把事实抄进账本。

**为什么名字要在传之前就发下来。** 传字节是副作用，它发生之前双方必须先就「这个对象
叫什么」达成一致，否则连接在响应到达前断掉，那份已经落进桶里的东西就没人认领了（和
运行 id 必须由客户端预先铸造是同一个道理，见不变量 8——只是这里由服务端铸造，更严
一档）。

**登记这一步不采信客户端的任何声明。** 它连请求体都没有：真实 key、多大、什么类型
全部来自我们自己的桶。客户端能左右的只有「登记哪一个 assetId」，而那个 id 是服务端
发的、猜不着的。
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from iclip.common.errors import Conflict, ValidationFailed
from iclip.domains.assets.models import (
    MAX_BYTES,
    UPLOAD_TYPES,
    Asset,
    AssetType,
    UploadTicket,
)
from iclip.domains.assets.repository import AssetRepository
from iclip.domains.assets.schemas import MAX_LIST_LIMIT
from iclip.domains.identity.public import Principal
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.oss import SIGNED_PUT_EXPIRES_SECONDS, SignedUploadStore


class AssetService:
    """签直传许可、登记素材、读账本。"""

    def __init__(self, repo: AssetRepository, objects: SignedUploadStore) -> None:
        self._repo = repo
        self._objects = objects

    def sign_upload(self, content_type: str) -> UploadTicket:
        """发一个 assetId 并签出直传地址。"""

        normalized = content_type.split(";")[0].strip().lower()
        if normalized not in UPLOAD_TYPES:
            allowed = "、".join(sorted(UPLOAD_TYPES))
            raise ValidationFailed(f"不收 {normalized or '空'} 这个类型，只收：{allowed}")
        asset_id = uuid.uuid4()
        _, ext = UPLOAD_TYPES[normalized]
        upload_url = self._objects.sign_put(
            object_key=MEDIA_PATHS.upload(asset_id=asset_id, ext=ext),
            content_type=normalized,
        )
        return UploadTicket(
            asset_id=asset_id,
            upload_url=upload_url,
            content_type=normalized,
            # 取进程的钟：它只是把签名自己的有效期回显给客户端，不落库、不参与任何
            # 判断，所以不受「时刻一律取数据库的钟」那条约束。
            expires_at=datetime.now(UTC) + timedelta(seconds=SIGNED_PUT_EXPIRES_SECONDS),
        )

    async def register(self, principal: Principal, asset_id: uuid.UUID) -> Asset:
        """把桶里那个对象登记进账本。重复调用返回同一行。"""

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
                # 落库时由数据库改写成它自己的 now()，这里的值不会落库。
                created_at=datetime.now(UTC),
            )
        )

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
        """账本存的是 key，对外给的是按当前公网前缀拼出来的地址。"""

        return self._objects.public_url(asset.object_key)


__all__ = ["AssetService"]
