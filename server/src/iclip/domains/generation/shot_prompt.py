"""镜头组到视频提示词的拼装规则。

调用方交的是结构化的镜头组（与分镜文件 video_shot.json 同形：全局设定 + 逐镜起止秒与正文），
发给视频模型的却是一段正文。这段正文长什么样只在这里定：前端「复制完整提示词」照同一规则
显示，生成记录里存的也是这里拼出来的。改了这里就等于改了发给模型的东西。"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:  # 只为类型：schemas 要用这里的函数做校验，真导入会成环
    from iclip.domains.generation.schemas import VideoShotIn

OUTPUT_CONSTRAINT: Final = "不要生成字幕，不要生成背景音乐。"
"""每段正文的最后一行。"""

IMAGE_REFERENCE: Final = re.compile(r"@Image(\d+)")
"""正文里指向参考图的记号，编号从 1 起、对应 ``reference_image_urls`` 的位置。"""

_TIME_PLACES: Final = 3
"""起止秒数保留到毫秒，整秒不带小数点：JSON 里的 4.0 与浏览器里的 4 才会拼出同一行。"""


def image_indexes_of(text: str) -> list[int]:
    """正文里引用了哪几张图，按首次出现的顺序去重。"""

    seen: list[int] = []
    for match in IMAGE_REFERENCE.finditer(text):
        number = int(match.group(1))
        if number not in seen:
            seen.append(number)
    return seen


def format_seconds(value: float) -> str:
    """整秒不带小数点，其余去掉末尾的零：3.5、4、8.25。"""

    return f"{round(value, _TIME_PLACES):.{_TIME_PLACES}f}".rstrip("0").rstrip(".")


def format_shot_prompt(shot: VideoShotIn) -> str:
    """全局设定、空一行、每镜一行 ``[起–止秒｜镜头N] 正文``、末尾约束。起止照给的，不重算。"""

    lines: list[str] = []
    for position, item in enumerate(shot.timeline, start=1):
        start, end = item.timestamps
        lines.append(
            f"[{format_seconds(start)}–{format_seconds(end)}秒｜镜头{position}] {item.prompt}"
        )
    return f"{shot.global_settings}\n\n" + "\n".join(lines) + f"\n{OUTPUT_CONSTRAINT}"


__all__ = [
    "IMAGE_REFERENCE",
    "OUTPUT_CONSTRAINT",
    "format_seconds",
    "format_shot_prompt",
    "image_indexes_of",
]
