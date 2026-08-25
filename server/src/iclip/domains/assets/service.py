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

还有第三条路：**转存**（``import_from_url``）。外部地址上的东西要进账本就得先搬进
我们自己的桶——账本行上只有 ``object_key``，没有放外部地址的地方。这条路上字节穿过
我们的进程，所以类型、大小、尺寸全是实测的。
"""

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
    """签直传许可、登记素材、转存外部地址、读账本。"""

    def __init__(self, repo: AssetRepository, objects: PublicBucket) -> None:
        self._repo = repo
        self._objects = objects

    def sign_upload(self, body: UploadSignIn) -> UploadTicket:
        """发一个 assetId 并签出直传地址。"""

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

    async def import_from_url(self, principal: Principal, source_url: str) -> Asset:
        """把一个外部地址上的东西搬进桶里并登记，返回那一行。

        **源地址算 id**：同一张产品图被多少张需求单引用都只搬一次，重复调用连请求都
        不发。代价是上游原地换了图我们不会跟着更新——那正是转存想要的，链接烂不掉。
        """

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
        """搬过就返回那一行。仓储只有「没有就抛」那一件，这里把它翻成一个问句。"""

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
        """账本存的是 key，对外给的是按当前公网前缀拼出来的地址。"""

        return self._objects.public_url(asset.object_key)


def _accepted_type(content_type: str) -> tuple[AssetType, str, str]:
    """归一化一个 content type，并查出它算哪一类、扩展名是什么。不收的就抛。"""

    normalized = content_type.split(";")[0].strip().lower()
    known = UPLOAD_TYPES.get(normalized)
    if known is None:
        allowed = "、".join(sorted(UPLOAD_TYPES))
        raise ValidationFailed(f"不收 {normalized or '空'} 这个类型，只收：{allowed}")
    return known[0], known[1], normalized


async def _download(source_url: str) -> tuple[bytes, str]:
    """把一个地址上的字节整份取回来，连它自报的 content type。

    **不跟随重定向**（httpx 的默认，这里只是别去打开它）：取回来的字节会落进公开桶，
    跟着 302 走就等于把这条口子变成任意地址的搬运工。
    """

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
                # 边读边卡：整份读完再判大小的话，一个指错的地址就能把进程撑爆。
                # 这里用的是所有类型里最宽的那条线，具体类型的上限由调用方再卡一次。
                if read > _READ_CEILING:
                    raise ValidationFailed(f"这个地址上的东西太大了：{source_url}")
                chunks.append(chunk)
    except httpx.HTTPError as exc:
        raise ValidationFailed(f"这个地址取不回来：{source_url}") from exc
    return b"".join(chunks), content_type


__all__ = ["AssetService"]
