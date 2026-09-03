"""用户附在消息里的图和视频：进模型的形状，与从消息还原回 part 列表的形状。

一条 prompt 送进引擎之后就只剩消息历史了，所以图和视频的身份必须写进消息本身——写法沿用
``harness.media`` 那套媒体 tag：正文里留一条 ``<image url=...>``，紧跟着喂给模型的那份像素。
刷新之后从消息推 transcript 时，正是靠解这条 tag 把那一项还原回 ``ImageContent``。

**还原必须逐项对应，不合并。** 界面按 part 的次序画图文，两项文字并成一项就把图挪了位置。
"""

from __future__ import annotations

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
from iclip.platform.transcript.ops import (
    AttachmentSource,
    ImageContent,
    PromptContent,
    TextContent,
    VideoContent,
)


def model_prompt(content: Sequence[PromptContent]) -> list[UserContent]:
    """一条 prompt 的各部分 → 送进 ``run_stream_events`` 的那一串。

    图片喂的是缩过的那一份（长边 ``IMAGE_CONTEXT_MAX_EDGE``），而 tag 里记的始终是原图地址：
    「拿去看的那一份」和「它是谁」从来是两个地址。缩不动就只留 tag，不把 4K 原图整个塞进上下文。

    视频只留一条 tag：模型这一侧读不了它，但它得留在消息里，否则刷新之后这一项就没了。
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


def prompt_content(items: Sequence[Any]) -> tuple[PromptContent, ...]:
    """消息里那一串 → 用户发上来的 part 列表。

    非文本项（喂给模型的那份像素）跳过：它是 tag 包着的内容，身份已经在开标签里了，而且
    地址上带着缩放参数——part 里要的是原图地址。闭标签同样跳过：图片是「开标签 + 像素 +
    闭标签」三项，漏掉它界面上就多一行 ``</image>``。
    """

    parts: list[PromptContent] = []
    for item in items:
        if not isinstance(item, str):
            continue
        if is_media_tag_close(item):
            continue
        tag = parse_media_tag(item)
        if tag is None:
            parts.append(TextContent(text=item))
            continue
        source = AttachmentSource(kind="url", url=tag.url)
        if tag.kind == "image":
            parts.append(ImageContent(source=source))
        elif tag.kind == "video":
            parts.append(VideoContent(source=source))
        else:
            # 用户消息里只有图和视频（见 ``model_prompt``），别的 tag 形状是他自己打的字。
            parts.append(TextContent(text=item))
    return tuple(parts)


def plain_text(content: Sequence[PromptContent]) -> str:
    """一串 part 里的纯文字：文字 part 直接相接，不插分隔。

    实时那条路与历史那条路都拿它填用户块的 ``text``，各写一遍迟早会漂，刷新前后就不一样了。
    """

    return "".join(part.text for part in content if part.type == "text")


__all__ = [
    "model_prompt",
    "plain_text",
    "prompt_content",
]
