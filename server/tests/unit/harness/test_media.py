"""媒体引用协议：入站换形状、出站换回来，两个方向必须对得上。"""

from __future__ import annotations

import base64
from dataclasses import dataclass

import pytest
from ag_ui.core import (
    AssistantMessage,
    AudioInputContent,
    BinaryInputContent,
    DocumentInputContent,
    ImageInputContent,
    InputContent,
    InputContentDataSource,
    InputContentUrlSource,
    Message,
    TextInputContent,
    UserMessage,
    VideoInputContent,
)

from iclip.harness.media import (
    MAX_INLINE_MEDIA_BYTES,
    MediaCodec,
    media_tag,
    parse_media_tag,
    resized_image_url,
)

OSS = "https://bucket.oss-cn-hangzhou.aliyuncs.com"
VIDEO_URL = f"{OSS}/ref.mp4"
IMAGE_URL = f"{OSS}/style.jpg"


@dataclass
class FakeStore:
    """最小状态机：按 key 存一份，同 key 复用同一个地址。"""

    written: dict[str, bytes] | None = None

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        if self.written is None:
            self.written = {}
        self.written[object_key] = content
        return f"{OSS}/{object_key}"


def user(*parts: InputContent) -> UserMessage:
    return UserMessage(id="m1", role="user", content=list(parts))


def text(value: str) -> TextInputContent:
    return TextInputContent(type="text", text=value)


def url_part(kind: str, url: str, *, mime: str, filename: str | None = None) -> InputContent:
    source = InputContentUrlSource(type="url", value=url, mime_type=mime)
    metadata = {"filename": filename} if filename else None
    if kind == "image":
        return ImageInputContent(type="image", source=source, metadata=metadata)
    if kind == "video":
        return VideoInputContent(type="video", source=source, metadata=metadata)
    if kind == "audio":
        return AudioInputContent(type="audio", source=source, metadata=metadata)
    return DocumentInputContent(type="document", source=source, metadata=metadata)


def data_part(kind: str, payload: bytes, *, mime: str) -> InputContent:
    source = InputContentDataSource(
        type="data", value=base64.b64encode(payload).decode(), mime_type=mime
    )
    if kind == "image":
        return ImageInputContent(type="image", source=source)
    return VideoInputContent(type="video", source=source)


def content_of(message: Message) -> list[InputContent]:
    """取出一条用户消息的分段内容（``Message`` 是联合类型，得先落到 user 上）。"""

    assert isinstance(message, UserMessage)
    assert not isinstance(message.content, str)
    return list(message.content)


async def parts_of(codec: MediaCodec, *parts: InputContent) -> list[InputContent]:
    """跑一次入站，取出改写后的那条用户消息内容。"""

    return content_of((await codec.rewrite([user(*parts)]))[0])


def texts(parts: list[InputContent]) -> list[str]:
    return [part.text for part in parts if isinstance(part, TextInputContent)]


# --- 文法 ---------------------------------------------------------------


def test_tag_round_trips_url_and_name() -> None:
    tag = parse_media_tag(media_tag("video", VIDEO_URL, name="参考 & <片>.mp4"))

    assert tag is not None
    assert (tag.kind, tag.url, tag.name) == ("video", VIDEO_URL, "参考 & <片>.mp4")


def test_tag_rejects_url_with_whitespace() -> None:
    """地址带空白的 tag 回解析不出来，出站时尖括号会原样漏给前端。"""

    with pytest.raises(ValueError):
        media_tag("image", "https://oss/a b.jpg")


def test_only_a_whole_line_counts_as_a_tag() -> None:
    assert parse_media_tag(f'看这个 <video url="{VIDEO_URL}"></video>') is None


# --- 入站 ---------------------------------------------------------------


async def test_video_becomes_a_tag_and_leaves_no_media_part() -> None:
    """模型面不收视频字节：只留地址，要看内容得走工具。"""

    parts = await parts_of(
        MediaCodec(), url_part("video", VIDEO_URL, mime="video/mp4", filename="ref.mp4")
    )

    assert texts(parts) == [f'<video url="{VIDEO_URL}" name="ref.mp4"></video>']
    assert len(parts) == 1


async def test_image_pixels_are_wrapped_by_the_tag() -> None:
    """图片两样都给，而且像素被包在一对 tag 中间：地址与它显示的那张图是连着的一段。"""

    parts = await parts_of(MediaCodec(), url_part("image", IMAGE_URL, mime="image/jpeg"))

    assert texts(parts) == [f'<image url="{IMAGE_URL}">', "</image>"]
    pixels = parts[1]
    assert isinstance(pixels, ImageInputContent)
    assert isinstance(pixels.source, InputContentUrlSource)
    assert pixels.source.value == f"{IMAGE_URL}?x-oss-process=image/resize,l_1024"


async def test_order_is_preserved_and_plain_text_passes_through() -> None:
    parts = await parts_of(
        MediaCodec(),
        text("参考这个片子"),
        url_part("video", VIDEO_URL, mime="video/mp4"),
        text("风格照这张图"),
    )

    assert texts(parts) == [
        "参考这个片子",
        f'<video url="{VIDEO_URL}"></video>',
        "风格照这张图",
    ]


async def test_document_is_carried_as_the_file_kind() -> None:
    parts = await parts_of(
        MediaCodec(), url_part("document", f"{OSS}/brief.pdf", mime="application/pdf")
    )

    assert texts(parts) == [f'<file url="{OSS}/brief.pdf"></file>']


async def test_deprecated_binary_part_is_carried_by_mime_prefix() -> None:
    parts = await parts_of(
        MediaCodec(),
        BinaryInputContent(type="binary", mime_type="audio/mpeg", url=f"{OSS}/bgm.mp3"),
    )

    assert texts(parts) == [f'<audio url="{OSS}/bgm.mp3"></audio>']


async def test_string_content_and_other_roles_are_untouched() -> None:
    messages: list[Message] = [
        UserMessage(id="m1", role="user", content="就一句话"),
        AssistantMessage(id="m2", role="assistant", content="好的"),
    ]

    assert await MediaCodec().rewrite(messages) == messages


# --- 入站：内嵌 base64 -------------------------------------------------


async def test_inline_content_lands_on_one_address_per_content() -> None:
    """前端每轮重送整段历史，同一份字节必须落回同一个地址，否则身份每轮都变。"""

    codec = MediaCodec(objects=FakeStore())
    same = data_part("image", b"\xff\xd8\xffsame", mime="image/jpeg")
    other = data_part("image", b"\xff\xd8\xffother", mime="image/jpeg")

    first = texts(await parts_of(codec, same))
    again = texts(await parts_of(codec, same))
    different = texts(await parts_of(codec, other))

    assert first == again
    assert first != different


@pytest.mark.parametrize(
    ("part", "reason"),
    [
        (data_part("video", b"x", mime="video/x-flv"), "内嵌上传不支持该类型"),
        (
            VideoInputContent(
                type="video",
                source=InputContentDataSource(
                    type="data", value="不是 base64", mime_type="video/mp4"
                ),
            ),
            "内容无法解码",
        ),
        (
            data_part("video", b"\x00" * (MAX_INLINE_MEDIA_BYTES + 1), mime="video/mp4"),
            "上限",
        ),
        (url_part("video", "file:///etc/passwd", mime="video/mp4"), "HTTP"),
    ],
)
async def test_unusable_media_is_replaced_in_place_not_dropped(
    part: InputContent, reason: str
) -> None:
    """模型得知道有东西没进来，否则它会以为用户什么都没发。"""

    parts = await parts_of(MediaCodec(objects=FakeStore()), text("看这个"), part)

    assert len(parts) == 2
    assert parts[1].text.startswith("[媒体不可用：")  # pyright: ignore[reportAttributeAccessIssue]
    assert reason in parts[1].text  # pyright: ignore[reportAttributeAccessIssue]


async def test_inline_content_without_an_object_store_says_so() -> None:
    parts = await parts_of(MediaCodec(), data_part("image", b"bytes", mime="image/png"))

    assert "内嵌上传不可用" in parts[0].text  # pyright: ignore[reportAttributeAccessIssue]


# --- 出站 ---------------------------------------------------------------


async def test_tags_become_media_parts_again() -> None:
    codec = MediaCodec()
    sent = [
        user(text("参考这个"), url_part("video", VIDEO_URL, mime="video/mp4", filename="ref.mp4"))
    ]

    restored = codec.restore(await codec.rewrite(sent))

    content = content_of(restored[0])
    assert [part.type for part in content] == ["text", "video"]
    video = content[1]
    assert isinstance(video, VideoInputContent)
    assert isinstance(video.source, InputContentUrlSource)
    assert video.source.value == VIDEO_URL
    assert video.metadata == {"filename": "ref.mp4"}


async def test_restored_image_is_the_original_not_the_thumbnail() -> None:
    """出站还原走 tag 里的身份地址；缩略图那份是喂模型的，不该回到前端。"""

    codec = MediaCodec()
    sent = [user(url_part("image", IMAGE_URL, mime="image/jpeg"))]

    restored = codec.restore(await codec.rewrite(sent))

    content = content_of(restored[0])
    assert len(content) == 1
    image = content[0]
    assert isinstance(image, ImageInputContent)
    assert isinstance(image.source, InputContentUrlSource)
    assert image.source.value == IMAGE_URL


def test_a_pixel_part_with_no_tag_in_front_of_it_survives() -> None:
    """没有 tag 认领的图片 part 是别处来的，原样交给前端。"""

    restored = MediaCodec().restore([user(url_part("image", IMAGE_URL, mime="image/jpeg"))])

    content = content_of(restored[0])
    assert len(content) == 1
    assert isinstance(content[0], ImageInputContent)


def test_text_that_is_not_a_tag_stays_text() -> None:
    restored = MediaCodec().restore([user(text("我打了个 <video> 字"))])

    assert content_of(restored[0]) == [text("我打了个 <video> 字")]


# --- 缩放 ---------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://cdn.example.com/a.jpg",  # 自定义域名：缩放参数它不认
        f"{IMAGE_URL}?v=2",  # 已经带 query：再拼一个就废了
    ],
)
def test_resize_only_applies_where_it_works(url: str) -> None:
    assert resized_image_url(url, max_edge=1024) == url
