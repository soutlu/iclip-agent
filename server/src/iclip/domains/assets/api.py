"""素材的 HTTP 面。

两组路由，一件事：``/uploads/*`` 是文件进系统的入口，``/assets/*`` 是账本。分开是因为
它们的对象不同——前者操作的是桶里的字节，后者操作的是账本上的行。转存挂在账本这一
组，因为它交付的是账本上的一行，搬字节只是它的手段。

权限用现成的 ``assets:read`` / ``assets:write``，权限词汇表里早就留好了这两个名字。
素材是全公司共用的，所以这里不存在「别人的返 404」那套写法：不存在才 404。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from iclip.domains.assets.models import AssetType
from iclip.domains.assets.schemas import (
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
    AssetEnvelope,
    AssetImportIn,
    AssetsPageOut,
    UploadInstruction,
    UploadSignIn,
    UploadTicketOut,
    asset_out,
)
from iclip.domains.assets.service import AssetService
from iclip.domains.identity.public import Principal, require_permission


def create_uploads_router(service: AssetService) -> APIRouter:
    router = APIRouter(prefix="/uploads", tags=["uploads"])

    @router.post("/sign", response_model=UploadTicketOut)
    async def sign_upload(
        body: UploadSignIn,
        _: Annotated[Principal, Depends(require_permission("assets:write"))],
    ) -> UploadTicketOut:
        ticket = service.sign_upload(body)
        return UploadTicketOut(
            asset_id=ticket.asset_id,
            upload=UploadInstruction(
                url=ticket.upload_url,
                headers={"Content-Type": ticket.content_type},
                expires_at=ticket.expires_at,
            ),
        )

    return router


def create_assets_router(service: AssetService) -> APIRouter:
    router = APIRouter(prefix="/assets", tags=["assets"])

    # 这条必须声明在 ``/{asset_id}`` 之前：路由按声明顺序匹配，反过来的话 import
    # 会被当成一个 assetId，报一个「不是合法 UUID」的 422。
    @router.post("/import", response_model=AssetEnvelope, status_code=201)
    async def import_asset(
        body: AssetImportIn,
        principal: Annotated[Principal, Depends(require_permission("assets:write"))],
    ) -> AssetEnvelope:
        """把一个外部地址上的东西转存进我们的桶并登记，返回带新地址的那一行。

        同一个地址重复调用返回同一行（也还是 201），不会在桶里搬第二份。
        """

        asset = await service.import_from_url(principal, body.url)
        return AssetEnvelope(asset=asset_out(asset, url=service.public_url(asset)))

    @router.post("/{asset_id}", response_model=AssetEnvelope, status_code=201)
    async def register_asset(
        asset_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("assets:write"))],
    ) -> AssetEnvelope:
        """登记一份已经直传上来的素材。没有请求体：事实全部从桶里读。

        重复登记返回同一行（也还是 201）——客户端断线重试是正常路径，让它区分「这次
        是不是我建的」没有意义。
        """

        asset = await service.register(principal, asset_id)
        return AssetEnvelope(asset=asset_out(asset, url=service.public_url(asset)))

    @router.get("", response_model=AssetsPageOut)
    async def list_assets(
        _: Annotated[Principal, Depends(require_permission("assets:read"))],
        creator_user_id: Annotated[uuid.UUID | None, Query(alias="creatorUserId")] = None,
        asset_type: Annotated[AssetType | None, Query(alias="assetType")] = None,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
    ) -> AssetsPageOut:
        found = await service.list_recent(
            creator_user_id=creator_user_id, asset_type=asset_type, limit=limit
        )
        return AssetsPageOut(
            items=[asset_out(asset, url=service.public_url(asset)) for asset in found]
        )

    @router.get("/{asset_id}", response_model=AssetEnvelope)
    async def get_asset(
        asset_id: uuid.UUID,
        _: Annotated[Principal, Depends(require_permission("assets:read"))],
    ) -> AssetEnvelope:
        asset = await service.get(asset_id)
        return AssetEnvelope(asset=asset_out(asset, url=service.public_url(asset)))

    return router


__all__ = ["create_assets_router", "create_uploads_router"]
