"""逐格生成请求的纯校验。

镜头组表的结构与规则在 [shot_document](../shot_document.py)，两条创作流共用。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated

from pydantic import BaseModel, Field
from pydantic_ai import ModelRetry

from iclip.capabilities.shot_video.prompt import GRID_CELLS
from iclip.capabilities.shot_video.shots import CELL_ID_SHAPE, ShotParseError, parse_cell_id


class FrameRequest(BaseModel):
    """一格的生成请求。"""

    no: Annotated[
        str, Field(description=f"帧号，{CELL_ID_SHAPE} 形状；挑中候选帧的直接用板上的帧号。")
    ]
    prompt: Annotated[str, Field(description="为这一帧撰写的 visual_prompt。")]


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


__all__ = [
    "FrameRequest",
    "resolve_cells",
    "resolve_requests",
]
