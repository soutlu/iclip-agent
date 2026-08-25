"""上传的 wire 形状与它的两条闸门：多大、什么类型。

**类型白名单同时决定文件后缀。** 客户端报的文件名不参与命名——它是用户输入，拼进
对象 key 就是把命名权交给外面。

字段名对外一律 camelCase（见仓库根的 contract/conventions.md §3）。
"""

from __future__ import annotations

from typing import Final

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

MAX_UPLOAD_BYTES: Final = 256 * 1024 * 1024
"""单个文件的上限。字节要整个进内存才能交给对象存储，所以它也是一次请求的内存占用。"""

EXTENSION_BY_CONTENT_TYPE: Final[dict[str, str]] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
}
"""收哪些类型，以及它们在对象 key 上的后缀。表外的一律拒，不猜。"""


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)


class UploadOut(CamelModel):
    url: str
    """公网地址。它就是素材的身份——写进需求单的 brief、或者放进对话消息的媒体 part。"""
    content_type: str


class UploadEnvelope(CamelModel):
    upload: UploadOut


__all__ = [
    "EXTENSION_BY_CONTENT_TYPE",
    "MAX_UPLOAD_BYTES",
    "UploadEnvelope",
    "UploadOut",
]
