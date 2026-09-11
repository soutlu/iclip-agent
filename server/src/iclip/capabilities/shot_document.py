"""镜头组 prompt 表的结构、校验与交付，供各条创作流共用。

两条创作流共用同一份文件、结构与写回规则。
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Annotated, Final

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic_ai import ModelRetry
from pydantic_ai.messages import ToolReturn

from iclip.common.tool_args import JsonText
from iclip.platform.file_store.store import FileStore, QuotaExceeded
from iclip.platform.transcript.display import tool_note

SHOTS_PATH: Final = "video_shot.json"
MAX_REFERENCE_IMAGES: Final = 30

SHOT_MIN_SECONDS: Final = 4
SHOT_MAX_SECONDS: Final = 30

_IMAGE_REF = re.compile(r"@Image(\d+)")
"""镜头组 prompt 里指向参考图的记号。"""


class AspectError(ValueError):
    """画幅写法不合法。"""


def parse_aspect(value: str) -> float:
    """把 ``宽:高`` 解析成宽高比。"""

    parts = value.split(":")
    if len(parts) != 2:
        raise AspectError(f"画幅要写成 宽:高，比如 9:16；收到的是 {value!r}")
    try:
        w, h = int(parts[0]), int(parts[1])
    except ValueError as exc:
        raise AspectError(f"画幅的两段必须是整数；收到的是 {value!r}") from exc
    if w <= 0 or h <= 0:
        raise AspectError(f"画幅必须是正数；收到的是 {value!r}")
    return w / h


TimestampSeconds = Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)]


class TimelineItem(BaseModel):
    """镜头组内一个镜头的起止秒数与正文。"""

    model_config = ConfigDict(extra="forbid")

    timestamps: Annotated[
        list[TimestampSeconds],
        Field(min_length=2, max_length=2, description="[开始秒数, 结束秒数]。"),
    ]
    prompt: Annotated[str, Field(description="该镜头的正文。")]


class VideoShotPrompt(BaseModel):
    """同一镜头组共用的设定与逐镜时间线。"""

    model_config = ConfigDict(extra="forbid")

    global_settings: Annotated[str, Field(description="本组的全局设定。")]
    timeline: Annotated[
        list[TimelineItem], Field(min_length=1, description="按镜头顺序排列的时间线。")
    ]


class VideoShotRequest(BaseModel):
    """提交工具接收的一个镜头组。"""

    index: Annotated[int, Field(description="镜头组编号，从 1 连续编号。")]
    prompt: Annotated[VideoShotPrompt, JsonText]
    seconds: Annotated[int, Field(description="本组总时长，取整秒，4-30。")]
    image_urls: Annotated[
        list[str],
        Field(
            max_length=MAX_REFERENCE_IMAGES,
            description="本组镜头帧地址，@ImageN 即第 N 张；无图传 []，最多 30 张。",
        ),
    ]


class StoredTimelineItem(TimelineItem):
    """文件中一个镜头的原始内容与从正文提取的图片编号。"""

    image_indexes: list[Annotated[int, Field(strict=True, ge=1)]]


class StoredVideoShotPrompt(BaseModel):
    """文件中的镜头组提示词，仅比提交内容多逐镜图片编号。"""

    model_config = ConfigDict(extra="forbid")

    global_settings: str
    timeline: Annotated[list[StoredTimelineItem], Field(min_length=1)]


class VideoShotDocumentRow(BaseModel):
    """工作区镜头组表的一行，独立于工具入参模型。"""

    model_config = ConfigDict(extra="forbid")

    index: int
    prompt: StoredVideoShotPrompt
    seconds: int
    image_urls: Annotated[list[str], Field(max_length=MAX_REFERENCE_IMAGES)]


class VideoShotsDocument(BaseModel):
    """镜头组表文件的结构；字段名与工具入参一致。

    文件写回不区分生成它的创作流。
    """

    model_config = ConfigDict(extra="forbid")

    aspect_ratio: str
    shots: list[VideoShotDocumentRow]


def validate_video_shot_requests(
    shots: Sequence[VideoShotRequest | VideoShotDocumentRow],
) -> None:
    """校验整份结构化入参，非法时抛 ModelRetry；不改写文本、时间或图片顺序。

    素材来源由工具输入验证器检查；本函数不访问工作区或序列化交付文件。
    """

    if not shots:
        raise ModelRetry("shots 一条都没有；镜头组 prompt 表不能是空的。")
    for position, shot in enumerate(shots, start=1):
        if shot.index != position:
            raise ModelRetry(f"index 要从 1 连续编号：第 {position} 条写的是 {shot.index}。")
        if not SHOT_MIN_SECONDS <= shot.seconds <= SHOT_MAX_SECONDS:
            raise ModelRetry(
                f"镜头组 {shot.index} 的 seconds 是 {shot.seconds}，只收 "
                f"{SHOT_MIN_SECONDS}-{SHOT_MAX_SECONDS}；重新切分这一组再交付。"
            )
        if any(not url.strip() for url in shot.image_urls):
            raise ModelRetry(f"镜头组 {shot.index} 的 image_urls 里有空地址。")
        if not shot.prompt.global_settings.strip():
            raise ModelRetry(f"镜头组 {shot.index} 的 prompt.global_settings 为空。")
        _validate_image_refs(
            shot.prompt.global_settings,
            where=f"镜头组 {shot.index} 的 prompt.global_settings",
            image_count=len(shot.image_urls),
        )

        previous_end = 0.0
        for shot_number, item in enumerate(shot.prompt.timeline, start=1):
            where = f"镜头组 {shot.index} 的第 {shot_number} 镜"
            if not item.prompt.strip():
                raise ModelRetry(f"{where}的 prompt 为空。")
            start, end = item.timestamps
            if end <= start:
                raise ModelRetry(
                    f"{where}的 timestamps 为 [{start}, {end}]；结束时间必须大于开始时间。"
                )
            if shot_number == 1 and start != 0:
                raise ModelRetry(f"{where}从 {start} 秒开始；每个镜头组的第一镜必须从 0 开始。")
            if start < previous_end:
                raise ModelRetry(
                    f"{where}从 {start} 秒开始，早于上一镜的结束时间 {previous_end} 秒；"
                    "各镜头时间段必须按先后顺序排列且不得重叠。"
                )
            _validate_image_refs(
                item.prompt, where=f"{where}的 prompt", image_count=len(shot.image_urls)
            )
            previous_end = end


def _validate_image_refs(prompt: str, *, where: str, image_count: int) -> None:
    for number in _IMAGE_REF.findall(prompt):
        if not 1 <= int(number) <= image_count:
            raise ModelRetry(
                f"{where} 引用了 @Image{number}，但本组 image_urls 只有 {image_count} 张图片；"
                "编号必须从 1 开始且不超过图片数。"
            )


def extract_image_indexes(prompt: str) -> list[int]:
    """按正文首次出现顺序提取图片编号，保留编号语义并去重。"""

    return list(dict.fromkeys(int(number) for number in _IMAGE_REF.findall(prompt)))


def build_video_shots_document(
    aspect_ratio: str, shots: Sequence[VideoShotRequest]
) -> VideoShotsDocument:
    """校验整份提交并补充逐镜图片编号，失败时抛 ModelRetry；不改写输入或访问存储。"""

    try:
        parse_aspect(aspect_ratio)
    except AspectError as exc:
        raise ModelRetry(str(exc)) from exc
    validate_video_shot_requests(shots)
    return VideoShotsDocument(
        aspect_ratio=aspect_ratio,
        shots=[
            VideoShotDocumentRow(
                index=shot.index,
                prompt=StoredVideoShotPrompt(
                    global_settings=shot.prompt.global_settings,
                    timeline=[
                        StoredTimelineItem(
                            timestamps=list(item.timestamps),
                            prompt=item.prompt,
                            image_indexes=extract_image_indexes(item.prompt),
                        )
                        for item in shot.prompt.timeline
                    ],
                ),
                seconds=shot.seconds,
                image_urls=list(shot.image_urls),
            )
            for shot in shots
        ],
    )


def validate_shots_document(content: str) -> VideoShotsDocument:
    """校验写回的镜头组表并返回解析结果，非法时抛 ValueError。

    与提交共用字段校验，并检查派生的图片编号；模型工具的地址来源校验不属于此入口。
    """

    try:
        document = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{SHOTS_PATH} 不是合法的 JSON：{exc}") from exc
    if not isinstance(document, dict):
        raise ValueError(f"{SHOTS_PATH} 的根必须是一个对象。")
    aspect_ratio = document.get("aspect_ratio")
    if not isinstance(aspect_ratio, str):
        raise ValueError("aspect_ratio 要写成 9:16 这样的字符串。")
    raw_shots = document.get("shots")
    if not isinstance(raw_shots, list):
        raise ValueError("shots 要写成一个数组。")
    try:
        parse_aspect(aspect_ratio)
    except AspectError as exc:
        raise ValueError(str(exc)) from exc
    try:
        parsed = VideoShotsDocument.model_validate(document)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(part) for part in first["loc"]) or "字段"
        raise ValueError(f"{SHOTS_PATH} 的 {where}：{first['msg']}") from exc
    try:
        validate_video_shot_requests(parsed.shots)
    except ModelRetry as exc:
        raise ValueError(str(exc)) from exc
    for shot in parsed.shots:
        for position, item in enumerate(shot.prompt.timeline, start=1):
            expected = extract_image_indexes(item.prompt)
            if item.image_indexes != expected:
                raise ValueError(
                    f"镜头组 {shot.index} 的第 {position} 镜 image_indexes 与正文引用不一致；"
                    f"应为 {expected}。"
                )
    return parsed


async def deliver_shots(
    files: FileStore,
    namespace: str,
    *,
    aspect_ratio: str,
    shots: Sequence[VideoShotRequest],
) -> ToolReturn[str]:
    """整份交付镜头组 prompt 表，替换共用分镜文件上已有的内容。"""

    document = build_video_shots_document(aspect_ratio, shots)
    try:
        await files.write(namespace, SHOTS_PATH, document.model_dump_json(indent=2))
    except QuotaExceeded as exc:
        raise ModelRetry(
            f"工作区写不下 {SHOTS_PATH}：{exc} 用 delete_file 清掉不用的文件。"
        ) from exc
    group_count = len(document.shots)
    shot_count = sum(len(shot.prompt.timeline) for shot in document.shots)
    seconds = sum(shot.seconds for shot in document.shots)
    return ToolReturn(
        return_value=(
            f"镜头组 prompt 表已交付到 {SHOTS_PATH}："
            f"{group_count} 个镜头组，{shot_count} 个镜头，合计 {seconds} 秒。"
        ),
        metadata=tool_note(chip=f"{group_count} 组 · {shot_count} 镜 · {seconds} 秒"),
    )


__all__ = [
    "MAX_REFERENCE_IMAGES",
    "SHOTS_PATH",
    "SHOT_MAX_SECONDS",
    "SHOT_MIN_SECONDS",
    "AspectError",
    "StoredTimelineItem",
    "StoredVideoShotPrompt",
    "TimelineItem",
    "VideoShotDocumentRow",
    "VideoShotPrompt",
    "VideoShotRequest",
    "VideoShotsDocument",
    "build_video_shots_document",
    "deliver_shots",
    "extract_image_indexes",
    "parse_aspect",
    "validate_shots_document",
    "validate_video_shot_requests",
]
