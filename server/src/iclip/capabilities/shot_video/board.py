"""预览板合成：等格拼版，每格左上角叠印帧号。

给模型看的中间产物，不进图像生成。帧号是模型引用某一格的唯一凭据，所以它必须
烧进像素里——写在旁边的文字清单对不上格子。

按路径读帧而不是收一堆 bytes：一段几分钟的片子按秒抽帧就是几百张，全捧在内存里
没必要。
"""

from __future__ import annotations

import io
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BOARD_GAP_PX = 6
BOARD_MAX_EDGE = 2048

_BACKGROUND = (18, 18, 18)
_PLATE_RGBA = (0, 0, 0, 200)
_TEXT_RGBA = (255, 255, 255, 255)
_MIN_COLS = 2
_MAX_COLS = 6
_MIN_LABEL_PT = 18
_LABEL_PT_DIVISOR = 7
_JPEG_QUALITY = 88


class BoardError(RuntimeError):
    """预览板合成失败。"""


@dataclass(frozen=True, slots=True)
class BoardGeometry:
    """一块板的排布与格尺寸（格尺寸取偶数）。"""

    cols: int
    rows: int
    cell_width: int
    cell_height: int


def image_aspect(path: Path) -> float:
    """读图像宽高比（宽 / 高）。"""

    try:
        with Image.open(path) as image:
            width, height = image.size
    except OSError as exc:
        raise BoardError(f"图像解不开: {path.name}") from exc
    if height <= 0:
        raise BoardError(f"图像高度非法: {height}")
    return width / height


def board_geometry(
    cell_count: int, *, cell_aspect: float, max_edge: int = BOARD_MAX_EDGE, gap: int = BOARD_GAP_PX
) -> BoardGeometry:
    """选让整版最接近方形的列数，再由长边上限反推格尺寸。

    整版越接近方形，同样的长边下每格越大——竖长格尤其明显。
    """

    if cell_count <= 0:
        raise BoardError(f"预览板格数必须为正: {cell_count}")
    if cell_aspect <= 0:
        raise BoardError(f"格宽高比必须为正: {cell_aspect}")
    cols = min(_MAX_COLS, max(_MIN_COLS, round(math.sqrt(cell_count / cell_aspect))))
    cols = min(cols, cell_count)
    rows = math.ceil(cell_count / cols)
    if cols * cell_aspect >= rows:
        cell_width = (max_edge - gap * (cols - 1)) // cols
        cell_height = round(cell_width / cell_aspect)
    else:
        cell_height = (max_edge - gap * (rows - 1)) // rows
        cell_width = round(cell_height * cell_aspect)
    cell_width -= cell_width % 2
    cell_height -= cell_height % 2
    if cell_width <= 0 or cell_height <= 0:
        raise BoardError(f"长边上限 {max_edge} 放不下 {cell_count} 格（{cols}×{rows}）")
    return BoardGeometry(cols=cols, rows=rows, cell_width=cell_width, cell_height=cell_height)


def compose_board(
    cells: Sequence[tuple[str, Path]], *, geometry: BoardGeometry, gap: int = BOARD_GAP_PX
) -> bytes:
    """按阅读顺序拼一张板，返回 JPEG 字节。末排空位保留底色。"""

    if not cells:
        raise BoardError("预览板至少需要一格")
    if len(cells) > geometry.cols * geometry.rows:
        raise BoardError(f"{len(cells)} 格放不进 {geometry.cols}×{geometry.rows} 排布")

    width = geometry.cols * geometry.cell_width + gap * (geometry.cols - 1)
    height = geometry.rows * geometry.cell_height + gap * (geometry.rows - 1)
    canvas = Image.new("RGB", (width, height), _BACKGROUND)
    draw = ImageDraw.Draw(canvas, "RGBA")
    font = ImageFont.load_default(size=max(_MIN_LABEL_PT, geometry.cell_width // _LABEL_PT_DIVISOR))

    for index, (text, source) in enumerate(cells):
        x = (index % geometry.cols) * (geometry.cell_width + gap)
        y = (index // geometry.cols) * (geometry.cell_height + gap)
        try:
            with Image.open(source) as frame:
                resized = frame.convert("RGB").resize(
                    (geometry.cell_width, geometry.cell_height), Image.Resampling.LANCZOS
                )
        except OSError as exc:
            raise BoardError(f"预览板第 {index + 1} 格图像解不开") from exc
        canvas.paste(resized, (x, y))
        _draw_label(draw, x=x, y=y, text=text, font=font)

    buffer = io.BytesIO()
    canvas.save(buffer, format="JPEG", quality=_JPEG_QUALITY)
    return buffer.getvalue()


def _draw_label(draw: ImageDraw.ImageDraw, *, x: int, y: int, text: str, font: object) -> None:
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)  # type: ignore[arg-type]
    pad = max(4, getattr(font, "size", _MIN_LABEL_PT) // 3)
    draw.rectangle(
        (x, y, x + (right - left) + pad * 2, y + (bottom - top) + pad * 2), fill=_PLATE_RGBA
    )
    draw.text((x + pad - left, y + pad - top), text, font=font, fill=_TEXT_RGBA)  # type: ignore[arg-type]


__all__ = [
    "BOARD_GAP_PX",
    "BOARD_MAX_EDGE",
    "BoardError",
    "BoardGeometry",
    "board_geometry",
    "compose_board",
    "image_aspect",
]
