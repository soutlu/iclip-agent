"""镜头组与视频提示词之间的拼装规则及其逆。

调用方交的是结构化的镜头组（与分镜文件 video_shot.json 同形：全局设定 + 逐镜起止秒与正文），
发给视频模型的却是一段正文。这段正文长什么样只在这里定：前端「复制完整提示词」照同一规则
显示，生成记录里存的也是这里拼出来的。改了这里就等于改了发给模型的东西。

反拆给读历史记录用：结构化字段上线前（2026-09-09）出的片只存了按这套规则拼好的正文。"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Protocol

from iclip.common.shot_rules import image_indexes_of, timeline_fault

OUTPUT_CONSTRAINT: Final = "不要生成字幕，不要生成背景音乐。"
"""每段正文的最后一行。"""

_TIME_PLACES: Final = 3
"""起止秒数保留到毫秒，整秒不带小数点：JSON 里的 4.0 与浏览器里的 4 才会拼出同一行。"""

_SHOT_MARKER: Final = re.compile(r"^\[(\d+(?:\.\d+)?)[–-](\d+(?:\.\d+)?)秒｜镜头\d+\](?: (.*))?$")
"""一镜的开头 ``[起–止秒｜镜头N] 正文``。标记后没有空格与正文的，是 2026-09-08 之前
「标记独占一行、正文另起一行」的旧写法。"""


class ShotCutLike(Protocol):
    @property
    def timestamps(self) -> tuple[float, float]: ...

    @property
    def prompt(self) -> str: ...


class ShotLike(Protocol):
    @property
    def global_settings(self) -> str: ...

    @property
    def timeline(self) -> Sequence[ShotCutLike]: ...


@dataclass(frozen=True, slots=True)
class ShotCut:
    timestamps: tuple[float, float]
    prompt: str
    image_indexes: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class ShotScript:
    """从正文拆回来的镜头组，与出片请求里的 ``shot`` 同形。"""

    global_settings: str
    timeline: tuple[ShotCut, ...]


def format_seconds(value: float) -> str:
    """整秒不带小数点，其余去掉末尾的零：3.5、4、8.25。"""

    return f"{round(value, _TIME_PLACES):.{_TIME_PLACES}f}".rstrip("0").rstrip(".")


def format_shot_prompt(shot: ShotLike) -> str:
    """全局设定、空一行、每镜一行 ``[起–止秒｜镜头N] 正文``、末尾约束。起止照给的，不重算。"""

    lines: list[str] = []
    for position, item in enumerate(shot.timeline, start=1):
        start, end = item.timestamps
        lines.append(
            f"[{format_seconds(start)}–{format_seconds(end)}秒｜镜头{position}] {item.prompt}"
        )
    return f"{shot.global_settings}\n\n" + "\n".join(lines) + f"\n{OUTPUT_CONSTRAINT}"


def parse_shot_prompt(text: str) -> ShotScript | None:
    """``format_shot_prompt`` 的逆：按镜头标记拆回镜头组。

    对这里拼出来的正文拆回去再拼是一字不差的。旧写法（标记独占一行、约束行夹在全局设定里）
    也拆得开，但不保证拼回原样。拆不出镜头标记、或拆出的时间线接不上（结束不晚于开始、
    第一镜不从 0 起、镜头交叠），都不算镜头组，返回 None，调用方按纯文本处理。
    """

    preamble: list[str] = []
    cuts: list[tuple[float, float, list[str]]] = []
    for line in text.split("\n"):
        marker = _SHOT_MARKER.match(line)
        if marker is not None:
            body = marker.group(3)
            cuts.append(
                (float(marker.group(1)), float(marker.group(2)), [] if body is None else [body])
            )
        elif line.strip() == OUTPUT_CONSTRAINT:
            continue
        elif cuts:
            cuts[-1][2].append(line)
        else:
            preamble.append(line)
    if not cuts:
        return None

    previous_end = 0.0
    for position, (start, end, _) in enumerate(cuts, start=1):
        if timeline_fault(position, start, end, previous_end) is not None:
            return None
        previous_end = end

    # 拼装时全局设定后面跟一个空行：其中一个换行成了行尾，另一个留成了空行，拆回来要去掉。
    global_settings = "\n".join(preamble)
    if global_settings.endswith("\n"):
        global_settings = global_settings[:-1]
    timeline = tuple(
        ShotCut(
            timestamps=(start, end),
            prompt="\n".join(body),
            image_indexes=tuple(image_indexes_of("\n".join(body))),
        )
        for start, end, body in cuts
    )
    return ShotScript(global_settings=global_settings, timeline=timeline)


__all__ = [
    "OUTPUT_CONSTRAINT",
    "ShotCut",
    "ShotCutLike",
    "ShotLike",
    "ShotScript",
    "format_seconds",
    "format_shot_prompt",
    "parse_shot_prompt",
]
