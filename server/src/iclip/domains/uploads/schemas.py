"""上传的 wire 形状。字段名对外一律 camelCase（见仓库根的 contract/conventions.md §3）。

**确认那一步只收替谁确认。** 文件的事实（多大、什么类型）照旧只从桶里读，客户端报什么都不作数，
所以请求体里没有描述文件的字段。
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from iclip.domains.uploads.models import ConfirmedUpload, UploadTicket

MAX_USER_NAME_CHARS: Final = 200
"""与 ``generation.schemas.MAX_USER_NAME_CHARS`` 同一个数；上传不依赖生成域，照抄。"""


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class UploadSignIn(CamelModel):
    """要传什么类型、图有多大。类型的取值范围见 ``models.UPLOAD_TYPES``。"""

    content_type: str = Field(min_length=1, max_length=100)
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    """图片的像素尺寸，传图必填、传视频不用给。区间见 ``models`` 里那两个常量。

    尺寸在这一步就卡掉，是为了让确认那条口子不收任何文件的事实；也为了不合格的图压根
    不用先传上来。
    """


class UploadInstruction(CamelModel):
    """浏览器照着它直传：往 ``url`` 发一个 PUT，headers 原样带上。

    ``headers`` 全部签进了签名里：Content-Type 限制类型，``x-oss-meta-*`` 记上传者与
    key。少一个、改一个，OSS 那边就验签不过。
    """

    url: str
    method: Literal["PUT"] = "PUT"
    headers: dict[str, str]
    expires_at: datetime
    """这条地址什么时候作废：过了它就不能再用来发起上传，得重新要一条。"""


class UploadTicketOut(CamelModel):
    """一次直传的许可：先拿到名字，再去传。

    ``uploadId`` 在字节落地之前就发下来，因为传这个副作用发生之前，双方必须先就「它
    叫什么」达成一致。确认时用它指这一次上传，确认后它就是那条上传记录的 id。
    """

    upload_id: uuid.UUID
    upload: UploadInstruction


class UploadConfirmIn(CamelModel):
    """确认上传时可选的请求体：替谁确认。"""

    user_name: (
        Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_USER_NAME_CHARS),
        ]
        | None
    ) = None
    """给了按替人办事换主体（浏览器只能写自己的用户名）；不给就记在当前主体名下，钥匙不带也不报错。"""


class UploadConfirmedOut(CamelModel):
    """确认后交回的地址与桶里读到的事实；``url`` 从此就是这个文件的身份。"""

    url: str
    content_type: str
    size_bytes: int


def ticket_out(ticket: UploadTicket) -> UploadTicketOut:
    return UploadTicketOut(
        upload_id=ticket.upload_id,
        upload=UploadInstruction(
            url=ticket.upload_url, headers=dict(ticket.headers), expires_at=ticket.expires_at
        ),
    )


def confirmed_out(confirmed: ConfirmedUpload) -> UploadConfirmedOut:
    return UploadConfirmedOut(
        url=confirmed.url, content_type=confirmed.content_type, size_bytes=confirmed.size_bytes
    )


__all__ = [
    "MAX_USER_NAME_CHARS",
    "UploadConfirmIn",
    "UploadConfirmedOut",
    "UploadInstruction",
    "UploadSignIn",
    "UploadTicketOut",
    "confirmed_out",
    "ticket_out",
]
