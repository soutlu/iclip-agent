"""使用合成灰度图验证网格检测、等分回退、画幅收缩和坐标还原。"""

from __future__ import annotations

from collections.abc import Collection

import pytest

from iclip.capabilities.shot_video.grid import (
    GrayImage,
    GridError,
    fit_box_to_aspect,
    grid_cell_boxes,
    parse_aspect,
    parse_pgm,
    scale_box,
)

GUTTER = 255
CELL = 128


def make_image(
    width: int,
    height: int,
    *,
    white_cols: Collection[int] = (),
    white_rows: Collection[int] = (),
) -> GrayImage:
    """构造灰度图：指定整行、整列为白色分隔带，其余像素为中灰。"""

    cols, rows = set(white_cols), set(white_rows)
    pixels = bytearray(CELL for _ in range(width * height))
    for y in range(height):
        for x in range(width):
            if x in cols or y in rows:
                pixels[y * width + x] = GUTTER
    return GrayImage(width=width, height=height, pixels=bytes(pixels))


def to_pgm(image: GrayImage) -> bytes:
    return f"P5\n{image.width} {image.height}\n255\n".encode() + image.pixels


def test_pgm_roundtrip() -> None:
    image = make_image(8, 4, white_cols={3})
    parsed = parse_pgm(to_pgm(image))
    assert (parsed.width, parsed.height, parsed.pixels) == (8, 4, image.pixels)


def test_pgm_header_comments_and_whitespace() -> None:
    body = bytes([CELL] * 4)
    parsed = parse_pgm(b"P5\n# \xe6\xb3\xa8\xe9\x87\x8a\n2   2\n255\n" + body)
    assert (parsed.width, parsed.height) == (2, 2)


@pytest.mark.parametrize(
    ("data", "fragment"),
    [
        (b"P6\n2 2\n255\n" + bytes(4), "魔数"),
        (b"P5\n2 2\n65535\n" + bytes(4), "maxval"),
        (b"P5\n0 2\n255\n" + bytes(4), "尺寸"),
        (b"P5\n2 2\n255\n" + bytes(3), "像素数据不够"),
        (b"P5\n2 x\n255\n" + bytes(4), "不是整数"),
        (b"P5\n2 2\n255", "空白分隔符"),
        (b"P5\n", "提前结束"),
    ],
    ids=["magic", "maxval", "size", "short", "not-int", "no-separator", "truncated"],
)
def test_pgm_rejects_broken_input(data: bytes, fragment: str) -> None:
    with pytest.raises(GridError, match=fragment):
        parse_pgm(data)


def test_detects_offset_gutter_and_trims_outer_border() -> None:

    image = make_image(
        100,
        100,
        white_cols={*range(0, 6), *range(44, 48), *range(95, 100)},
        white_rows={*range(48, 52)},
    )
    layout = grid_cell_boxes(image, rows=2, cols=2)
    assert layout.detected
    xs = {(x, w) for x, _, w, _ in layout.boxes}
    assert xs == {(6, 38), (48, 47)}


def test_falls_back_to_equal_split_and_says_so() -> None:

    layout = grid_cell_boxes(make_image(100, 100), rows=2, cols=2)
    assert layout.boxes == ((0, 0, 50, 50), (50, 0, 50, 50), (0, 50, 50, 50), (50, 50, 50, 50))
    assert not layout.detected


def test_one_axis_detected_is_not_detected() -> None:
    """任一轴检测失败都应标记等分回退，避免宣称所有坐标均来自检测。"""

    image = make_image(100, 100, white_cols={*range(44, 48)})
    layout = grid_cell_boxes(image, rows=2, cols=2)
    assert (layout.detected_x, layout.detected_y) == (True, False)
    assert not layout.detected


def test_gutter_outside_search_band_is_ignored() -> None:
    """离等分线太远的白带不是网格线（可能是画面本身的白色区域）。"""

    image = make_image(100, 100, white_cols={*range(10, 14)})
    layout = grid_cell_boxes(image, rows=1, cols=2)
    assert not layout.detected_x


def test_black_gutter_counts_too() -> None:
    pixels = bytearray(CELL for _ in range(100 * 10))
    for y in range(10):
        for x in range(46, 50):
            pixels[y * 100 + x] = 0
    layout = grid_cell_boxes(GrayImage(width=100, height=10, pixels=bytes(pixels)), rows=1, cols=2)
    assert layout.detected_x


@pytest.mark.parametrize(("rows", "cols"), [(0, 2), (2, 0), (7, 2), (2, 7), (-1, 2)])
def test_grid_side_bounds(rows: int, cols: int) -> None:
    with pytest.raises(GridError):
        grid_cell_boxes(make_image(40, 40), rows=rows, cols=cols)


def test_pixel_length_must_match_size() -> None:
    with pytest.raises(GridError, match="对不上"):
        grid_cell_boxes(GrayImage(width=10, height=10, pixels=b"\x80" * 99), rows=1, cols=1)


@pytest.mark.parametrize(
    "value", ["9", "9:16:1", "a:b", "0:16", "9:0", "-9:16", ""], ids=lambda v: v or "empty"
)
def test_aspect_rejects_broken_text(value: str) -> None:
    with pytest.raises(GridError):
        parse_aspect(value)


def test_aspect_parses() -> None:
    assert parse_aspect("16:9") == pytest.approx(16 / 9)


def test_aspect_within_tolerance_is_left_alone() -> None:
    box = (0, 0, 101, 100)
    assert fit_box_to_aspect(box, 1.0) == box


def test_aspect_shrinks_centered() -> None:
    assert fit_box_to_aspect((10, 20, 200, 100), 1.0) == (60, 20, 100, 100)
    assert fit_box_to_aspect((10, 20, 100, 200), 1.0) == (10, 70, 100, 100)


def test_aspect_shrink_handles_large_drift() -> None:

    assert fit_box_to_aspect((0, 0, 400, 100), 9 / 16) == (172, 0, 56, 100)


@pytest.mark.parametrize("box", [(0, 0, 0, 10), (0, 0, 10, 0), (0, 0, -1, 10)])
def test_aspect_rejects_empty_box(box: tuple[int, int, int, int]) -> None:
    with pytest.raises(GridError, match="尺寸非法"):
        fit_box_to_aspect(box, 1.0)


def test_scale_box_back_to_full_resolution() -> None:
    assert scale_box((10, 20, 30, 40), from_width=640, to_width=1280) == (20, 40, 60, 80)


@pytest.mark.parametrize(("from_width", "to_width"), [(0, 100), (100, 0), (-1, 100)])
def test_scale_box_rejects_bad_widths(from_width: int, to_width: int) -> None:
    with pytest.raises(GridError):
        scale_box((0, 0, 1, 1), from_width=from_width, to_width=to_width)
