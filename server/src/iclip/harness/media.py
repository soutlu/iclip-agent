"""模型媒体引用与消息还原协议。

媒体 tag 保存原始 URL 和文件名；图片另附像素，其余类型由工具读取内容。
tag 包含还原所需信息，无需查询存储；消息转换见 transcript.prompt_media。
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, Literal
from urllib.parse import urlsplit

MediaKind = Literal["image", "video", "audio", "file"]

_KIND_BY_WIRE_TYPE: Final[Mapping[str, MediaKind]] = {
    "image": "image",
    "audio": "audio",
    "video": "video",
    "document": "file",
}
_WIRE_TYPE_BY_KIND: Final[Mapping[MediaKind, str]] = {
    "image": "image",
    "audio": "audio",
    "video": "video",
    "file": "document",
}
_LABEL_BY_KIND: Final[Mapping[MediaKind, str]] = {
    "image": "图片",
    "video": "视频",
    "audio": "音频",
    "file": "文件",
}

IMAGE_CONTEXT_MAX_EDGE: Final = 1024
"""模型输入图片的最长边；tag 始终保留原图 URL。"""

# 属性值经 _escape_attr 转义后不含引号与尖括号；地址不含空白。
_URL_ATTR = r'[^"<>\s]+'
_OPEN = rf'<(image|video|audio|file) url="({_URL_ATTR})"(?: name="([^"<>]*)")?>'
_TAG_RE: Final = re.compile(rf"{_OPEN}</\1>")
"""视频、音频与文件使用的空标签。"""

_OPEN_RE: Final = re.compile(_OPEN)
"""图片开标签，后续为像素和闭标签。"""

_CLOSE_RE: Final = re.compile(r"</(image|video|audio|file)>")


def _escape_attr(value: str) -> str:
    return (
        value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")
    )


def _unescape_attr(value: str) -> str:
    return (
        value.replace("&gt;", ">").replace("&lt;", "<").replace("&quot;", '"').replace("&amp;", "&")
    )


def media_tag_open(kind: MediaKind, url: str, *, name: str | None = None) -> str:
    """生成媒体开标签；拒绝含空白的 URL，确保可按协议还原。"""

    if not _is_http_url(url):
        raise ValueError(f"媒体 tag 的地址只接受不含空白的 HTTP/HTTPS URL: {url!r}")
    name_attr = f' name="{_escape_attr(name)}"' if name else ""
    return f'<{kind} url="{_escape_attr(url)}"{name_attr}>'


def media_kind_label(kind: MediaKind) -> str:
    """媒体类型的显示名称。"""

    return _LABEL_BY_KIND[kind]


def media_tag_close(kind: MediaKind) -> str:
    """生成媒体闭标签。"""

    return f"</{kind}>"


def media_tag(kind: MediaKind, url: str, *, name: str | None = None) -> str:
    """生成无像素内容的完整媒体标签。"""

    return media_tag_open(kind, url, name=name) + media_tag_close(kind)


@dataclass(frozen=True, slots=True)
class MediaTag:
    """解析后的媒体标签。"""

    kind: MediaKind
    url: str
    name: str | None = None
    wraps: bool = False
    """是否为包含后续像素与闭标签的开标签。"""


def parse_media_tag(text: str) -> MediaTag | None:
    """仅解析完整匹配的媒体标签，保留用户正文中的类似文本。"""

    match = _TAG_RE.fullmatch(text)
    wraps = match is None
    if match is None:
        match = _OPEN_RE.fullmatch(text)
    if match is None:
        return None
    kind, url, name = match.group(1), match.group(2), match.group(3)
    return MediaTag(
        kind=kind,  # pyright: ignore[reportArgumentType]
        url=_unescape_attr(url),
        name=_unescape_attr(name) if name else None,
        wraps=wraps,
    )


def is_media_tag_close(text: str) -> bool:
    """识别完整闭标签，在还原图片附件时跳过；正文中的标签字样保持原样。"""

    return _CLOSE_RE.fullmatch(text) is not None


def resized_image_url(url: str, *, max_edge: int) -> str:
    """添加 OSS 缩放参数；无法处理时抛错，避免未经缩放的原图进入模型上下文。"""

    _require_oss_processable(url, what=f"图片没法缩到长边 {max_edge}")
    return f"{url}?x-oss-process=image/resize,l_{max_edge}"


def cropped_image_url(
    url: str, *, x: int, y: int, width: int, height: int, max_edge: int | None
) -> str:
    """添加 OSS 原图坐标裁切参数；可选 max_edge 在裁切后缩放，越界部分由 OSS 截止至图像边界。"""

    _require_oss_processable(url, what="图片没法按区域裁切")
    process = f"image/crop,x_{x},y_{y},w_{width},h_{height}"
    if max_edge is not None:
        process += f"/resize,l_{max_edge}"
    return f"{url}?x-oss-process={process}"


def _require_oss_processable(url: str, *, what: str) -> None:
    """校验 OSS 域名且 URL 不含已有 query，确保可追加处理参数。"""

    parsed = urlsplit(url)
    if not (parsed.hostname or "").endswith(".aliyuncs.com"):
        raise ValueError(f"这个域名不支持缩放参数，{what}: {url!r}")
    if parsed.query:
        raise ValueError(f"地址已经带了 query，没法再挂缩放参数: {url!r}")


def _is_http_url(value: str) -> bool:
    return value.startswith(("http://", "https://")) and not any(ch.isspace() for ch in value)


__all__ = [
    "IMAGE_CONTEXT_MAX_EDGE",
    "MediaKind",
    "MediaTag",
    "cropped_image_url",
    "is_media_tag_close",
    "media_kind_label",
    "media_tag",
    "media_tag_close",
    "media_tag_open",
    "parse_media_tag",
    "resized_image_url",
]
