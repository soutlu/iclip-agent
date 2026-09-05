"""网格裁剪几何：解析 PGM 并检测近白或近黑分隔带。

检测失败的轴使用等分，并通过 GridLayout.detected 显式报告。"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

_WHITESPACE = frozenset(b" \t\r\n\v\f")
_COMMENT = ord("#")

MAX_GRID_SIDE = 6
"""单边格数上限，用于限制每次调用的产物数量。"""


class GridError(ValueError):
    """网格几何的输入不合法（PGM 坏了、行列数越界、画幅写错）。"""


@dataclass(frozen=True, slots=True)
class GrayImage:
    """8-bit 灰度图，行主序。"""

    width: int
    height: int
    pixels: bytes


@dataclass(frozen=True, slots=True)
class GridLayout:
    """按阅读顺序排列的矩形及检测标志；坐标为输入灰度图中的 (x, y, w, h)。"""

    boxes: tuple[tuple[int, int, int, int], ...]
    detected_x: bool
    detected_y: bool

    @property
    def detected(self) -> bool:
        """两个轴均检测到实际分隔带。"""

        return self.detected_x and self.detected_y


_WHITE_LEVEL = 230
_BLACK_LEVEL = 25
_GUTTER_SHARE = 0.95
"""一行/一列里近纯白或近纯黑的占比达到多少才算分隔带。"""
_SEARCH_SHARE = 0.12
"""在理论等分线附近多大范围内找分隔带。"""
_MARGIN_CAP_SHARE = 0.08
"""外圈边框最多修掉多少。"""
_MIN_GUTTER_PX = 2
_ASPECT_TOLERANCE = 0.02


def parse_pgm(data: bytes) -> GrayImage:
    """解析一张二进制 P5 PGM（maxval 必须是 255）。"""

    magic, pos = _header_token(data, 0)
    if magic != b"P5":
        raise GridError(f"PGM 魔数必须是 P5，实际是 {magic!r}")
    width, pos = _header_int(data, pos, field="width")
    height, pos = _header_int(data, pos, field="height")
    maxval, pos = _header_int(data, pos, field="maxval")
    if width <= 0 or height <= 0:
        raise GridError(f"PGM 尺寸非法: {width}x{height}")
    if maxval != 255:
        raise GridError(f"PGM maxval 必须是 255，实际是 {maxval}")
    if pos >= len(data) or data[pos] not in _WHITESPACE:
        raise GridError("PGM maxval 后面缺一个空白分隔符")
    pos += 1
    end = pos + width * height
    if end > len(data):
        raise GridError("PGM 像素数据不够")
    return GrayImage(width=width, height=height, pixels=data[pos:end])


def grid_cell_boxes(image: GrayImage, *, rows: int, cols: int) -> GridLayout:
    """通过行列投影寻找理论等分线附近的分隔带并裁除外框，检测不足的轴使用等分。"""

    _check_side(rows, "rows")
    _check_side(cols, "cols")
    width, height = image.width, image.height
    if len(image.pixels) != width * height:
        raise GridError("灰度图的像素长度和尺寸对不上")
    # 用查找表批量分类灰度值，避免逐像素分支比较。
    table = bytes(
        1 if value >= _WHITE_LEVEL else 2 if value <= _BLACK_LEVEL else 0 for value in range(256)
    )
    mask = image.pixels.translate(table)
    col_flags = [_is_gutter(mask[x::width], height) for x in range(width)]
    row_flags = [_is_gutter(mask[y * width : (y + 1) * width], width) for y in range(height)]
    x_segments, detected_x = _axis_segments(col_flags, count=cols)
    y_segments, detected_y = _axis_segments(row_flags, count=rows)
    return GridLayout(
        boxes=tuple((x0, y0, x1 - x0, y1 - y0) for y0, y1 in y_segments for x0, x1 in x_segments),
        detected_x=detected_x,
        detected_y=detected_y,
    )


def parse_aspect(value: str) -> float:
    """把 ``宽:高`` 解析成宽高比。"""

    parts = value.split(":")
    if len(parts) != 2:
        raise GridError(f"画幅要写成 宽:高，比如 9:16；收到的是 {value!r}")
    try:
        w, h = int(parts[0]), int(parts[1])
    except ValueError as exc:
        raise GridError(f"画幅的两段必须是整数；收到的是 {value!r}") from exc
    if w <= 0 or h <= 0:
        raise GridError(f"画幅必须是正数；收到的是 {value!r}")
    return w / h


def fit_box_to_aspect(box: tuple[int, int, int, int], ratio: float) -> tuple[int, int, int, int]:
    """居中收缩到目标画幅；比例偏差在 2% 内时保留原矩形，避免无意义裁剪。"""

    x, y, w, h = box
    if w <= 0 or h <= 0:
        raise GridError(f"格区域尺寸非法: {box}")
    current = w / h
    if abs(current - ratio) / ratio <= _ASPECT_TOLERANCE:
        return box
    if current > ratio:
        new_w = max(1, round(h * ratio))
        return (x + (w - new_w) // 2, y, new_w, h)
    new_h = max(1, round(w / ratio))
    return (x, y + (h - new_h) // 2, w, new_h)


def scale_box(
    box: tuple[int, int, int, int], *, from_width: int, to_width: int
) -> tuple[int, int, int, int]:
    """把检测坐标系里的矩形放大回原图坐标系（检测在降采样图上做，裁剪在原图上做）。"""

    if from_width <= 0 or to_width <= 0:
        raise GridError("缩放的宽度必须是正数")
    factor = to_width / from_width
    x, y, w, h = box
    return (
        round(x * factor),
        round(y * factor),
        max(1, round(w * factor)),
        max(1, round(h * factor)),
    )


def _check_side(value: int, name: str) -> None:
    if not 1 <= value <= MAX_GRID_SIDE:
        raise GridError(f"{name} 必须在 1 到 {MAX_GRID_SIDE} 之间；收到的是 {value}")


def _is_gutter(line: bytes, size: int) -> bool:
    need = size * _GUTTER_SHARE
    return line.count(1) >= need or line.count(2) >= need


def _axis_segments(flags: Sequence[bool], *, count: int) -> tuple[list[tuple[int, int]], bool]:
    """沿一个轴切出 ``count`` 段；返回 ``(区间列表, 是否量到了真实分隔带)``。"""

    length = len(flags)
    naive = [(k * length // count, (k + 1) * length // count) for k in range(count)]
    if count == 1 or length < count * 4:
        return naive, False

    runs = _gutter_runs(flags)
    band = int(length * _SEARCH_SHARE)
    cuts: list[tuple[int, int]] = []
    hits = 0
    for k in range(1, count):
        boundary = k * length // count
        candidates = [
            run
            for run in runs
            if run[1] - run[0] >= _MIN_GUTTER_PX
            and run[0] <= boundary + band
            and run[1] >= boundary - band
        ]
        if not candidates:
            cuts.append((boundary, boundary))
            continue
        hits += 1
        cuts.append(min(candidates, key=lambda run: abs((run[0] + run[1]) // 2 - boundary)))

    margin_cap = int(length * _MARGIN_CAP_SHARE)
    lead = 0
    while lead < margin_cap and flags[lead]:
        lead += 1
    trail = length
    while trail > length - margin_cap and flags[trail - 1]:
        trail -= 1

    starts = [lead, *(end for _, end in cuts)]
    ends = [*(start for start, _ in cuts), trail]
    segments = list(zip(starts, ends, strict=True))
    # 区间不足等分宽度的一半时，视为该轴检测失败。
    min_len = length // (count * 2)
    if any(end - start < min_len for start, end in segments):
        return naive, False
    return segments, hits == count - 1


def _gutter_runs(flags: Sequence[bool]) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, flag in enumerate(flags):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(flags)))
    return runs


def _header_token(data: bytes, pos: int) -> tuple[bytes, int]:
    """读下一个头部 token，跳过空白与 ``#`` 注释。"""

    length = len(data)
    while pos < length:
        byte = data[pos]
        if byte in _WHITESPACE:
            pos += 1
        elif byte == _COMMENT:
            while pos < length and data[pos] not in (10, 13):
                pos += 1
        else:
            break
    if pos >= length:
        raise GridError("PGM 头部提前结束")
    start = pos
    while pos < length and data[pos] not in _WHITESPACE:
        pos += 1
    return data[start:pos], pos


def _header_int(data: bytes, pos: int, *, field: str) -> tuple[int, int]:
    token, next_pos = _header_token(data, pos)
    try:
        return int(token), next_pos
    except ValueError as exc:
        raise GridError(f"PGM 头部的 {field} 不是整数: {token!r}") from exc


__all__ = [
    "MAX_GRID_SIDE",
    "GrayImage",
    "GridError",
    "GridLayout",
    "fit_box_to_aspect",
    "grid_cell_boxes",
    "parse_aspect",
    "parse_pgm",
    "scale_box",
]
