"""用户附在消息里的图和视频：进模型的形状，与回到协议的形状。

一条 prompt 送进引擎之后就只剩消息历史了，所以附件的身份必须写进消息本身——写法沿用
``harness.media`` 那套媒体 tag：正文里留一条 ``<image src=...>``，紧跟着喂给模型的那份像素。
刷新之后从消息推 transcript 时，正是靠解这条 tag 把附件还原成协议里的 ``attachment`` 实体。

**附件 id 由地址算出来**，不由到达次序给：实时那条路与历史那条路都要产出它，两边算法只要不一样
就成了两个 id，同一张图在刷新前后会变成两张。
"""

from __future__ import annotations

import hashlib
import mimetypes
from collections.abc import Sequence
from typing import Any

from pydantic_ai.messages import ImageUrl, UserContent

from iclip.harness.media import (
    IMAGE_CONTEXT_MAX_EDGE,
    MediaKind,
    is_media_tag_close,
    media_tag,
    media_tag_close,
    media_tag_open,
    parse_media_tag,
    resized_image_url,
)
from iclip.platform.transcript.ops import Attachment, AttachmentSource, PromptContent


def attachment_id(url: str) -> str:
    """这张附件的 id。同一个地址永远得到同一个 id，两条路因此对得上。"""

    return f"att_{hashlib.sha1(url.encode('utf-8')).hexdigest()[:16]}"


def _media_type(kind: MediaKind, url: str, name: str | None) -> str:
    """猜这份东西的 MIME。协议要求这个字段有值，猜不出就给通用值，不编一个像样的。"""

    guessed, _ = mimetypes.guess_type(name or url.split("?", 1)[0])
    return guessed or f"{kind}/*"


def attachment_of(kind: MediaKind, url: str, *, name: str | None = None) -> Attachment:
    return Attachment(
        attachment_id=attachment_id(url),
        media_type=_media_type(kind, url, name),
        name=name,
        source=AttachmentSource(kind="url", url=url),
    )


def attachments_of(content: Sequence[PromptContent]) -> tuple[Attachment, ...]:
    """一条 prompt 附上的那些东西，去重后按出现次序。"""

    found: dict[str, Attachment] = {}
    for part in content:
        if part.type == "text" or part.source.url is None:
            continue
        kind: MediaKind = "image" if part.type == "image" else "video"
        item = attachment_of(kind, part.source.url)
        found[item.attachment_id] = item
    return tuple(found.values())


def model_prompt(content: Sequence[PromptContent]) -> list[UserContent]:
    """一条 prompt 的各部分 → 送进 ``run_stream_events`` 的那一串。

    图片喂的是缩过的那一份（长边 ``IMAGE_CONTEXT_MAX_EDGE``），而 tag 里记的始终是原图地址：
    「拿去看的那一份」和「它是谁」从来是两个地址。缩不动就只留 tag，不把 4K 原图整个塞进上下文。

    视频只留一条 tag：模型这一侧读不了它，但它得留在消息里，否则刷新之后这条附件就没了。
    """

    out: list[UserContent] = []
    for part in content:
        if part.type == "text":
            out.append(part.text)
            continue
        url = part.source.url
        if url is None:
            # 只收 url 来源的附件（见 PromptContent 的说明），别的形态到不了这里。
            continue
        kind: MediaKind = "image" if part.type == "image" else "video"
        if kind == "video":
            out.append(media_tag(kind, url))
            continue
        try:
            view = resized_image_url(url, max_edge=IMAGE_CONTEXT_MAX_EDGE)
        except ValueError:
            out.append(media_tag(kind, url))
            continue
        out.append(media_tag_open(kind, url))
        out.append(ImageUrl(url=view))
        out.append(media_tag_close(kind))
    return out


def read_prompt_items(items: Sequence[Any]) -> tuple[list[str], list[Attachment]]:
    """消息里那一串 → （用户打的字，附上的东西）。

    非文本项（喂给模型的那份像素）跳过：它是 tag 包着的内容，身份已经在开标签里了。闭标签
    同样跳过：图片是「开标签 + 像素 + 闭标签」三项，漏掉它界面上就多一行 ``</image>``。
    """

    texts: list[str] = []
    attachments: list[Attachment] = []
    for item in items:
        if not isinstance(item, str):
            continue
        if is_media_tag_close(item):
            continue
        tag = parse_media_tag(item)
        if tag is None:
            texts.append(item)
            continue
        attachments.append(attachment_of(tag.kind, tag.url, name=tag.name))
    return texts, attachments


__all__ = [
    "attachment_id",
    "attachment_of",
    "attachments_of",
    "model_prompt",
    "read_prompt_items",
]
