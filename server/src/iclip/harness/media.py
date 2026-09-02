"""媒体引用的文法：消息里怎么写一段图或视频。

模型看到的是一行自包含的文本 tag（``<video url="…" name="…"></video>``），据此拿到地址去
调工具。图片是唯一两样都给的：tag 之后紧跟一份像素，模型既读得到地址又看得见画面；视频、
音频、文件只有 tag——模型面不收它们的字节，要看内容得走工具。

tag 自包含（地址与文件名都写在里面），所以从消息里把附件还原出来是纯转换，不查任何库：
消息里已经带着还原所需的一切。谁来写、谁来读见 ``harness.transcript.prompt_media``。
"""

from __future__ import annotations

import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Final, Literal, cast
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
"""喂给模型的那份图的长边像素。tag 里的身份地址永远是原图，缩放只发生在喂像素这一刻。"""

# 属性值经 _escape_attr 转义后不含引号与尖括号；地址不含空白。
_URL_ATTR = r'[^"<>\s]+'
_OPEN = rf'<(image|video|audio|file) url="({_URL_ATTR})"(?: name="([^"<>]*)")?>'
_TAG_RE: Final = re.compile(rf"{_OPEN}</\1>")
"""空标签：地址给了，中间没有东西。视频、音频、文件只有这一种。"""

_OPEN_RE: Final = re.compile(_OPEN)
"""开标签：后面跟着像素与闭标签。图片走这一种，像素被包在中间。"""

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
    """造一条开标签：模型直接可用的地址，加可选文件名。

    地址含空白就抛：属性值里的空白没法被文法回解析，出站还原时这条 tag 会被当成
    普通文本原样发给前端，尖括号就漏出去了。
    """

    if not _is_http_url(url):
        raise ValueError(f"媒体 tag 的地址只接受不含空白的 HTTP/HTTPS URL: {url!r}")
    name_attr = f' name="{_escape_attr(name)}"' if name else ""
    return f'<{kind} url="{_escape_attr(url)}"{name_attr}>'


def media_kind_label(kind: MediaKind) -> str:
    """这个种类给人看的名字。"""

    return _LABEL_BY_KIND[kind]


def media_tag_close(kind: MediaKind) -> str:
    """造一条闭标签。"""

    return f"</{kind}>"


def media_tag(kind: MediaKind, url: str, *, name: str | None = None) -> str:
    """造一条空标签（开闭相连，中间没有像素）。"""

    return media_tag_open(kind, url, name=name) + media_tag_close(kind)


@dataclass(frozen=True, slots=True)
class MediaTag:
    """解析出来的一条媒体 tag。"""

    kind: MediaKind
    url: str
    name: str | None = None
    wraps: bool = False
    """真：这是开标签，后面还包着像素和闭标签。假：空标签，自成一条。"""


def parse_media_tag(text: str) -> MediaTag | None:
    """解析整体就是一条 tag 的文本；不是 tag 返回 ``None``。

    只认整体匹配：夹在句子中间的尖括号是用户打的字，不是协议产出的引用。
    """

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
    """这一项整体就是一条闭标签吗？

    图片是「开标签 + 像素 + 闭标签」三项，闭标签自己成一项，``parse_media_tag`` 解不出它。
    从消息里读回用户打的字时不跳过它，界面上就会多出一行 ``</image>``。

    只认整体匹配：用户正文里提到 ``</image>`` 是他打的字，不能吃掉。
    """

    return _CLOSE_RE.fullmatch(text) is not None


def iter_media_tags(text: str) -> Iterator[MediaTag]:
    """扫出一段文本里的全部 tag。

    只扫开标签：空标签的开头也是它，两种形状都扫得到，同一条也不会数两遍。
    """

    for match in _OPEN_RE.finditer(text):
        kind = cast("MediaKind", match.group(1))
        url, name = match.group(2), match.group(3)
        yield MediaTag(
            kind=kind,
            url=_unescape_attr(url),
            name=_unescape_attr(name) if name else None,
            wraps=not text.startswith(media_tag_close(kind), match.end()),
        )


def resized_image_url(url: str, *, max_edge: int) -> str:
    """给图片地址挂上 OSS 的缩放参数（长边 ``max_edge``，OSS 不放大小图）。

    缩放不了就抛，不原样返回：一张 4K 原图整个进上下文没有任何信号，只有账单会涨。
    部署换成自定义公网域之后读图会立刻响亮地失败，那时来扩这里的判断。
    """

    _require_oss_processable(url, what=f"图片没法缩到长边 {max_edge}")
    return f"{url}?x-oss-process=image/resize,l_{max_edge}"


def cropped_image_url(
    url: str, *, x: int, y: int, width: int, height: int, max_edge: int | None
) -> str:
    """给图片地址挂上 OSS 的裁切参数（原图像素坐标；越过右下边界的部分裁到边界为止）。

    ``max_edge`` 给了就再级联一道缩放：OSS 的处理参数按 ``/`` 顺序执行，所以缩的是裁出
    来的那一块，不是原图。
    """

    _require_oss_processable(url, what="图片没法按区域裁切")
    process = f"image/crop,x_{x},y_{y},w_{width},h_{height}"
    if max_edge is not None:
        process += f"/resize,l_{max_edge}"
    return f"{url}?x-oss-process={process}"


def _require_oss_processable(url: str, *, what: str) -> None:
    """图片处理参数只挂得上 OSS 自己的域名，而且地址上不能已经有 query。

    带 query 的地址再拼一个参数上去只会得到一个废地址。
    """

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
    "iter_media_tags",
    "media_kind_label",
    "media_tag",
    "media_tag_close",
    "media_tag_open",
    "parse_media_tag",
    "resized_image_url",
]
