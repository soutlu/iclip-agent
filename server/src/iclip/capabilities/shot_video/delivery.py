"""逐格生成请求与镜头组交付表的纯校验和序列化。"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any, Final

from pydantic import BaseModel, ValidationError
from pydantic_ai import ModelRetry

from iclip.capabilities.shot_video.grid import GridError, parse_aspect
from iclip.capabilities.shot_video.prompt import GRID_CELLS
from iclip.capabilities.shot_video.shots import ShotParseError, parse_cell_id

SHOTS_PATH: Final = "video_shot.json"

SHOT_MIN_SECONDS: Final = 4
SHOT_MAX_SECONDS: Final = 30

_IMAGE_REF = re.compile(r"@Image(\d+)")
"""镜头组 prompt 里指向参考图的记号。"""


class FrameRequest(BaseModel):
    """一格的生成请求。"""

    no: str
    prompt: str


class VideoShotRequest(BaseModel):
    """一个镜头组的交付内容。"""

    index: int
    prompt: str
    seconds: int
    image_urls: list[str]


def resolve_requests(frames: Sequence[FrameRequest]) -> tuple[list[str], list[str]]:
    """校验逐格请求与同批帧号唯一性，不要求帧号属于候选帧台账；新增或短镜头也可生成。"""

    if not 1 <= len(frames) <= GRID_CELLS:
        raise ModelRetry(f"frames 必须是 1-{GRID_CELLS} 条，当前 {len(frames)} 条。")
    cell_ids: list[str] = []
    prompts: list[str] = []
    for position, request in enumerate(frames, start=1):
        cell_id = request.no.strip()
        try:
            parse_cell_id(cell_id)
        except ShotParseError as exc:
            raise ModelRetry(str(exc)) from exc
        if cell_id in cell_ids:
            raise ModelRetry(f"帧号 {cell_id} 在同一次调用中重复。")
        prompt = request.prompt.strip()
        if not prompt:
            raise ModelRetry(f"第 {position} 条（{cell_id}）的 prompt 为空。")
        cell_ids.append(cell_id)
        prompts.append(prompt)
    return cell_ids, prompts


def resolve_cells(cells: Sequence[str]) -> list[str]:
    """校验补拍的逐格描述。"""

    if not 1 <= len(cells) <= GRID_CELLS:
        raise ModelRetry(f"cells 必须是 1-{GRID_CELLS} 条，当前 {len(cells)} 条。")
    descriptions: list[str] = []
    for position, cell in enumerate(cells, start=1):
        description = cell.strip()
        if not description:
            raise ModelRetry(f"第 {position} 格的描述为空。")
        descriptions.append(description)
    return descriptions


def resolve_shots(shots: Sequence[VideoShotRequest]) -> list[dict[str, Any]]:
    """校验并序列化整份镜头组表，任一条非法则拒绝。

    这里只校验结构，地址来源由工具输入验证器负责；工具交付与面板写回共用此规则。"""

    if not shots:
        raise ModelRetry("shots 一条都没有；镜头组 prompt 表不能是空的。")
    rows: list[dict[str, Any]] = []
    for position, shot in enumerate(shots, start=1):
        if shot.index != position:
            raise ModelRetry(f"index 要从 1 连续编号：第 {position} 条写的是 {shot.index}。")
        prompt = shot.prompt.strip()
        if not prompt:
            raise ModelRetry(f"镜头组 {shot.index} 的 prompt 为空。")
        if not SHOT_MIN_SECONDS <= shot.seconds <= SHOT_MAX_SECONDS:
            raise ModelRetry(
                f"镜头组 {shot.index} 的 seconds 是 {shot.seconds}，只收 "
                f"{SHOT_MIN_SECONDS}-{SHOT_MAX_SECONDS}；重新切分这一组再交付。"
            )
        if not shot.image_urls:
            raise ModelRetry(f"镜头组 {shot.index} 的 image_urls 为空；每组至少要有一张镜头帧。")
        if any(not url.strip() for url in shot.image_urls):
            raise ModelRetry(f"镜头组 {shot.index} 的 image_urls 里有空地址。")
        highest = max((int(number) for number in _IMAGE_REF.findall(prompt)), default=0)
        if highest > len(shot.image_urls):
            raise ModelRetry(
                f"镜头组 {shot.index} 的 prompt 写到了 @Image{highest}，但这一组只有 "
                f"{len(shot.image_urls)} 张镜头帧。"
            )
        rows.append(
            {
                "index": shot.index,
                "prompt": prompt,
                "seconds": shot.seconds,
                "imageUrls": list(shot.image_urls),
            }
        )
    return rows


def validate_video_shots_document(content: str) -> None:
    """校验写回的 video_shot.json，非法时抛 ValueError。

    与交付工具共用结构规则；模型工具的地址来源校验不属于此入口。"""

    try:
        document = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{SHOTS_PATH} 不是合法的 JSON：{exc}") from exc
    if not isinstance(document, dict):
        raise ValueError(f"{SHOTS_PATH} 的根必须是一个对象。")
    aspect_ratio = document.get("aspectRatio")
    if not isinstance(aspect_ratio, str):
        raise ValueError("aspectRatio 要写成 9:16 这样的字符串。")
    raw_shots = document.get("shots")
    if not isinstance(raw_shots, list):
        raise ValueError("shots 要写成一个数组。")
    try:
        parse_aspect(aspect_ratio)
    except GridError as exc:
        raise ValueError(str(exc)) from exc
    shots: list[VideoShotRequest] = []
    for position, row in enumerate(raw_shots, start=1):
        if not isinstance(row, dict):
            raise ValueError(f"第 {position} 个镜头组不是一个对象。")
        try:
            shots.append(
                VideoShotRequest.model_validate(
                    {
                        "index": row.get("index"),
                        "prompt": row.get("prompt"),
                        "seconds": row.get("seconds"),
                        "image_urls": row.get("imageUrls"),
                    }
                )
            )
        except ValidationError as exc:
            first = exc.errors()[0]
            where = ".".join(str(part) for part in first["loc"]) or "字段"
            raise ValueError(f"第 {position} 个镜头组的 {where}：{first['msg']}") from exc
    try:
        resolve_shots(shots)
    except ModelRetry as exc:
        raise ValueError(str(exc)) from exc


__all__ = [
    "SHOTS_PATH",
    "SHOT_MAX_SECONDS",
    "SHOT_MIN_SECONDS",
    "FrameRequest",
    "VideoShotRequest",
    "resolve_cells",
    "resolve_requests",
    "resolve_shots",
    "validate_video_shots_document",
]
