"""在模型消息中保存附件 tag，并逐项还原用户 part。

图片 tag 保存原图 URL，像素另行提供；还原时不合并文本 part，保持图文顺序。
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
    """构造模型输入：图片传入缩放像素且保留原图 tag，无法缩放时仅保留 tag；视频仅使用 tag。"""

    out: list[UserContent] = []
    for part in content:
        if part.type == "text":
            out.append(part.text)
            continue
        url = part.source.url
        if url is None:
            # 此边界仅接收 URL 类型附件。
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
    """从媒体 tag 还原原图引用，跳过模型像素与闭标签，保持用户 part 顺序。"""

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
            # 仅识别 model_prompt 产生的图片和视频标签，其余按用户正文保留。
            parts.append(TextContent(text=item))
    return tuple(parts)


def plain_text(content: Sequence[PromptContent]) -> str:
    """直接拼接文本 part，不加分隔符；实时与历史共用。"""

    return "".join(part.text for part in content if part.type == "text")


__all__ = [
    "model_prompt",
    "plain_text",
    "prompt_content",
]
