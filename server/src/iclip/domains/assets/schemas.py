"""素材账本的 wire 形状。字段名对外一律 camelCase（见仓库根的 contract/conventions.md §3）。

**登记那一步没有请求体。** 素材的一切事实（真实 key、多大、什么类型）都从桶里读回来，
客户端报什么都不作数，所以它连一个可填的字段都不该有。
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.domains.assets.models import Asset, AssetType

DEFAULT_LIST_LIMIT: Final = 20
MAX_LIST_LIMIT: Final = 100


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class UploadSignIn(CamelModel):
    """要传什么类型。取值范围见 ``models.UPLOAD_TYPES``。"""

    content_type: str = Field(min_length=1, max_length=100)


class UploadInstruction(CamelModel):
    """浏览器照着它直传：往 ``url`` 发一个 PUT，headers 原样带上。

    ``headers`` 里的 Content-Type 被签进签名里了，换一个 OSS 那边就验签不过。
    """

    url: str
    method: Literal["PUT"] = "PUT"
    headers: dict[str, str]
    expires_at: datetime
    """这条地址什么时候作废：过了它就不能再用来发起上传，得重新要一条。"""


class UploadTicketOut(CamelModel):
    """一次直传的许可：先拿到名字，再去传。

    ``assetId`` 在字节落地之前就发下来，因为传这个副作用发生之前，双方必须先就「它
    叫什么」达成一致。此时它还不是一份素材，是一个**没兑现的登记名额**——登记之前
    ``GET /assets/{id}`` 一律 404。
    """

    asset_id: uuid.UUID
    upload: UploadInstruction


class AssetOut(CamelModel):
    id: uuid.UUID
    asset_type: AssetType
    url: str
    """公网地址。库里存的是 object key，这一项是按当前配置的公网前缀拼出来的投影。"""
    content_type: str
    size_bytes: int
    creator_user_id: uuid.UUID
    created_at: datetime


class AssetEnvelope(CamelModel):
    asset: AssetOut


class AssetsPageOut(CamelModel):
    items: list[AssetOut]


def asset_out(asset: Asset, *, url: str) -> AssetOut:
    """领域行 → wire 形状。地址由调用方按 key 拼好传进来。"""

    return AssetOut(
        id=asset.id,
        asset_type=asset.asset_type,
        url=url,
        content_type=asset.content_type,
        size_bytes=asset.size_bytes,
        creator_user_id=asset.creator_user_id,
        created_at=asset.created_at,
    )


__all__ = [
    "DEFAULT_LIST_LIMIT",
    "MAX_LIST_LIMIT",
    "AssetEnvelope",
    "AssetOut",
    "AssetsPageOut",
    "UploadInstruction",
    "UploadSignIn",
    "UploadTicketOut",
    "asset_out",
]
