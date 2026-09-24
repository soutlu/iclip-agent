"""镜头组的纯判定：时间线连续、``@ImageN`` 引用与参考图上限；出片请求与分镜交付共用，文案各自写。"""

from __future__ import annotations

import re
from typing import Final, Literal

MAX_REFERENCE_IMAGES: Final = 30
"""一组镜头最多几张参考图，``@ImageN`` 的 N 不能超过实际张数。"""

_IMAGE_REFERENCE: Final = re.compile(r"@Image(\d+)")
"""正文里指向参考图的记号，编号从 1 起、对应本组图片的位置。"""

TimelineFault = Literal["not_after_start", "first_not_at_zero", "overlaps_previous"]
"""时间线断在哪条规则：结束不晚于开始、第一镜不从 0 起、早于上一镜的结束。"""


def image_indexes_of(text: str) -> list[int]:
    """正文里引用了哪几张图，按首次出现的顺序去重。"""

    return list(dict.fromkeys(int(number) for number in _IMAGE_REFERENCE.findall(text)))


def first_unavailable_image(text: str, available: int) -> int | None:
    """正文里第一个不在 ``1..available`` 内的 ``@ImageN`` 编号；都在范围内返回 None。"""

    return next((number for number in image_indexes_of(text) if not 1 <= number <= available), None)


def timeline_fault(
    position: int, start: float, end: float, previous_end: float
) -> TimelineFault | None:
    """第 ``position`` 镜（从 1 数）是否接得上：``previous_end`` 是上一镜的结束，第一镜传 0。"""

    if end <= start:
        return "not_after_start"
    if position == 1 and start != 0:
        return "first_not_at_zero"
    if start < previous_end:
        return "overlaps_previous"
    return None


__all__ = [
    "MAX_REFERENCE_IMAGES",
    "TimelineFault",
    "first_unavailable_image",
    "image_indexes_of",
    "timeline_fault",
]
