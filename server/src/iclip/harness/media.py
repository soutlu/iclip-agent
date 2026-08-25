"""媒体引用协议：前端形状 ↔ 模型形状的双向转换。

一段媒体有两副形状。给前端的是 AG-UI 规范的媒体 part（``type: video`` +
``source``），前端据此渲染卡片；给模型的是一行自包含的文本 tag
（``<video url="…" name="…"></video>``），模型据此拿到地址去调工具。入站把前者
换成后者，出站换回来，两个方向共用本模块这一套文法。

图片是唯一两样都给的：tag 之后紧跟一个像素 part，模型既读得到地址又看得见画面。
视频、音频、文件只有 tag——模型面不收它们的字节，要看内容得走工具。

tag 自包含（地址与文件名都写在里面），所以出站还原是纯转换，不查任何库；消息里
已经带着还原所需的一切。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, Literal, Protocol, cast
from urllib.parse import urlsplit

from ag_ui.core import (
    AudioInputContent,
    BinaryInputContent,
    DocumentInputContent,
    ImageInputContent,
    InputContent,
    InputContentUrlSource,
    Message,
    TextInputContent,
    UserMessage,
    VideoInputContent,
)

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

MAX_INLINE_MEDIA_BYTES: Final = 16 * 1024 * 1024
"""内嵌 base64 媒体的物化上限。正常路径是前端预签名直传，内嵌只是兜底。"""

IMAGE_CONTEXT_MAX_EDGE: Final = 1024
"""喂给模型的那份图的长边像素。tag 里的身份地址永远是原图，缩放只发生在喂像素这一刻。"""

_OSS_PREFIX: Final = "chat-media"
"""内嵌媒体物化后落在公开桶里的根。"""

_EXT_BY_MIME: Final[Mapping[str, str]] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-m4v": "m4v",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
}

# 属性值经 _escape_attr 转义后不含引号与尖括号；地址不含空白。
_URL_ATTR = r'[^"<>\s]+'
_OPEN = rf'<(image|video|audio|file) url="({_URL_ATTR})"(?: name="([^"<>]*)")?>'
_TAG_RE: Final = re.compile(rf"{_OPEN}</\1>")
"""空标签：地址给了，中间没有东西。视频、音频、文件只有这一种。"""

_OPEN_RE: Final = re.compile(_OPEN)
"""开标签：后面跟着像素与闭标签。图片走这一种，像素被包在中间。"""

_CLOSE_RE: Final = re.compile(r"</(image|video|audio|file)>")


class MediaObjectStore(Protocol):
    """内嵌媒体物化所需的对象存储；组合根注入实现，本模块不认识是哪家云。"""

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """写入公开对象，返回它的公网 URL。"""
        ...


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

    带 query 的地址同理——再拼一个参数上去只会得到一个废地址。
    """

    parsed = urlsplit(url)
    if not (parsed.hostname or "").endswith(".aliyuncs.com"):
        raise ValueError(f"这个域名不支持缩放参数，图片没法缩到长边 {max_edge}: {url!r}")
    if parsed.query:
        raise ValueError(f"地址已经带了 query，没法再挂缩放参数: {url!r}")
    return f"{url}?x-oss-process=image/resize,l_{max_edge}"


def _is_http_url(value: str) -> bool:
    return value.startswith(("http://", "https://")) and not any(ch.isspace() for ch in value)


@dataclass(frozen=True, slots=True)
class _Media:
    """从 wire part 上解析下来的媒体，还没落地成地址。"""

    kind: MediaKind
    url: str | None = None
    data: str | None = None
    mime_type: str | None = None
    filename: str | None = None


@dataclass(frozen=True, slots=True)
class _Notice:
    """媒体不可用的原位提示。内容性失败不静默丢弃，换成模型看得懂的一句话。"""

    text: str


def _notice(media: _Media, reason: str) -> _Notice:
    label = media.filename or media.url or "内嵌内容"
    return _Notice(f"[媒体不可用：{_LABEL_BY_KIND[media.kind]} {label}：{reason}]")


def _filename(metadata: object) -> str | None:
    if isinstance(metadata, Mapping):
        name = metadata.get("filename")
        if isinstance(name, str) and name.strip():
            return name.strip()
    return None


def _parse_part(part: InputContent) -> str | _Media:
    """把一个 wire part 解析成文本或待落地的媒体。"""

    if isinstance(part, TextInputContent):
        return part.text
    if isinstance(part, BinaryInputContent):
        prefix = part.mime_type.split("/", 1)[0].lower()
        kind: MediaKind = prefix if prefix in ("image", "audio", "video") else "file"  # pyright: ignore[reportAssignmentType]
        return _Media(
            kind=kind,
            url=part.url,
            data=part.data,
            mime_type=part.mime_type,
            filename=part.filename,
        )
    source = part.source
    is_url = isinstance(source, InputContentUrlSource)
    return _Media(
        kind=_KIND_BY_WIRE_TYPE[part.type],
        url=source.value if is_url else None,
        data=None if is_url else source.value,
        mime_type=source.mime_type,
        filename=_filename(part.metadata),
    )


def _media_part(kind: MediaKind, *, url: str, filename: str | None) -> InputContent:
    """造一个前端形状的媒体 part。"""

    source = InputContentUrlSource(type="url", value=url)
    metadata = {"filename": filename} if filename else None
    wire_type = _WIRE_TYPE_BY_KIND[kind]
    if wire_type == "image":
        return ImageInputContent(type="image", source=source, metadata=metadata)
    if wire_type == "video":
        return VideoInputContent(type="video", source=source, metadata=metadata)
    if wire_type == "audio":
        return AudioInputContent(type="audio", source=source, metadata=metadata)
    return DocumentInputContent(type="document", source=source, metadata=metadata)


def _wrapped_length(items: Sequence[InputContent], start: int, kind: MediaKind) -> int:
    """开标签后面裹住了几个 part：中间的像素（可能没有）加一个闭标签。"""

    end = start
    if end < len(items) and isinstance(items[end], ImageInputContent):
        end += 1
    head = items[end] if end < len(items) else None
    if isinstance(head, TextInputContent) and head.text == media_tag_close(kind):
        end += 1
    return end - start


@dataclass(frozen=True, slots=True)
class MediaCodec:
    """两个方向的转换器。``objects`` 为空即没有内嵌上传的落点。"""

    objects: MediaObjectStore | None = None

    async def rewrite(self, messages: Sequence[Message]) -> list[Message]:
        """入站：把用户消息里的媒体 part 换成模型形状。

        只动 user 消息，其余原样。纯文本 content 直通——用户没带附件时不必绕路。

        内容性失败（超限、类型不支持、坏 base64、地址不合法）原位换成一条提示文
        本，模型知道有东西没进来；基础设施失败（对象存储写不进去）照常抛出，这一
        步发生在开流之前，所以调用方拿到的是正常的错误响应而不是流中途的报错。
        """

        rewritten: list[Message] = []
        for message in messages:
            if not isinstance(message, UserMessage) or isinstance(message.content, str):
                rewritten.append(message)
                continue
            parts: list[InputContent] = []
            for part in message.content:
                parsed = _parse_part(part)
                if isinstance(parsed, str):
                    parts.append(TextInputContent(type="text", text=parsed))
                    continue
                landed = await self._landed(parsed)
                if isinstance(landed, _Notice):
                    parts.append(TextInputContent(type="text", text=landed.text))
                    continue
                if parsed.kind != "image":
                    parts.append(
                        TextInputContent(
                            type="text", text=media_tag(parsed.kind, landed, name=parsed.filename)
                        )
                    )
                    continue
                try:
                    view = resized_image_url(landed, max_edge=IMAGE_CONTEXT_MAX_EDGE)
                except ValueError as exc:
                    parts.append(TextInputContent(type="text", text=_notice(parsed, str(exc)).text))
                    continue
                parts.append(
                    TextInputContent(
                        type="text", text=media_tag_open("image", landed, name=parsed.filename)
                    )
                )
                parts.append(
                    ImageInputContent(
                        type="image",
                        source=InputContentUrlSource(
                            type="url", value=view, mime_type=parsed.mime_type
                        ),
                    )
                )
                parts.append(TextInputContent(type="text", text=media_tag_close("image")))
            rewritten.append(message.model_copy(update={"content": parts}))
        return rewritten

    def restore(self, messages: Sequence[Message]) -> list[Message]:
        """出站：把用户消息里的 tag 换回前端形状。纯转换，不查库。

        一条 tag 连同它包住的东西一起收成一个 part：开标签里有地址与文件名，中间那
        份像素是喂模型的缩略档，闭标签只是收尾。还原出来的是开标签里那个原图地址，
        不是缩略档——身份与「拿去看的那一份」从来是两个地址。
        """

        restored: list[Message] = []
        for message in messages:
            if not isinstance(message, UserMessage) or isinstance(message.content, str):
                restored.append(message)
                continue
            items = list(message.content)
            parts: list[InputContent] = []
            wrapped = 0
            for position, item in enumerate(items):
                if wrapped:
                    wrapped -= 1
                    continue
                if not isinstance(item, TextInputContent):
                    parts.append(item)
                    continue
                tag = parse_media_tag(item.text)
                if tag is None:
                    parts.append(item)
                    continue
                parts.append(_media_part(tag.kind, url=tag.url, filename=tag.name))
                if tag.wraps:
                    wrapped = _wrapped_length(items, position + 1, tag.kind)
            restored.append(message.model_copy(update={"content": parts}))
        return restored

    async def _landed(self, media: _Media) -> str | _Notice:
        """解出媒体的公网地址；内嵌的 base64 先物化进对象存储。"""

        if media.url is not None:
            return media.url if _is_http_url(media.url) else _notice(media, "地址不是 HTTP/HTTPS")
        if not media.data:
            return _notice(media, "既没有地址也没有内容")
        if self.objects is None:
            return _notice(media, "本服务没有配置对象存储，内嵌上传不可用")
        mime = (media.mime_type or "").split(";")[0].strip().lower()
        ext = _EXT_BY_MIME.get(mime)
        if ext is None:
            return _notice(media, f"内嵌上传不支持该类型（{mime or '未知类型'}）")
        try:
            content = base64.b64decode(media.data, validate=True)
        except (binascii.Error, ValueError):
            return _notice(media, "内容无法解码")
        if not content:
            return _notice(media, "内容为空")
        if len(content) > MAX_INLINE_MEDIA_BYTES:
            return _notice(media, f"内容超过 {MAX_INLINE_MEDIA_BYTES // (1024 * 1024)}MB 上限")
        # key 由内容算出：前端每轮都会把整段历史重送一遍，同一份字节必须落到同一
        # 个地址上，否则同一张图每轮换一个身份，还白传一次。
        digest = hashlib.sha256(content).hexdigest()
        return await self.objects.put_public_object(
            object_key=f"{_OSS_PREFIX}/{digest}.{ext}",
            content=content,
            content_type=mime,
        )


__all__ = [
    "IMAGE_CONTEXT_MAX_EDGE",
    "MAX_INLINE_MEDIA_BYTES",
    "MediaCodec",
    "MediaKind",
    "MediaObjectStore",
    "MediaTag",
    "iter_media_tags",
    "media_kind_label",
    "media_tag",
    "media_tag_close",
    "media_tag_open",
    "parse_media_tag",
    "resized_image_url",
]
