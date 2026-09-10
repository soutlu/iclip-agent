"""全片统一栅格采样：采样点归属、帧号排号与短镜头无帧。"""

from __future__ import annotations

import pytest

from iclip.capabilities.shot_video.shots import ShotSpan, sample_rows


def ids(rows: tuple[tuple[ShotSpan, ...], ...]) -> list[list[str]]:
    return [[cell.cell_id for cell in row] for row in sample_rows(rows)]


def test_sampling_points_go_to_the_shot_covering_them() -> None:
    """帧号形如 S<镜头号>-<序号>，序号在镜头内从 1 起排。"""

    rows = ((ShotSpan(shot_id=1, start_ms=0, end_ms=2000),),)

    assert ids(rows) == [["S1-1", "S1-2"]]


def test_the_grid_does_not_move_with_shot_boundaries() -> None:
    """镜头怎么切都不挪采样点：第二个镜头从 2000ms 这个栅格点开始。"""

    rows = (
        (
            ShotSpan(shot_id=1, start_ms=0, end_ms=2000),
            ShotSpan(shot_id=2, start_ms=2000, end_ms=3000),
        ),
    )

    assert ids(rows) == [["S1-1", "S1-2", "S2-1"]]


def test_a_shot_between_two_grid_points_gets_nothing() -> None:
    """短于一秒且落在栅格点之间的镜头不补中点，一格都不给。"""

    rows = (
        (
            ShotSpan(shot_id=1, start_ms=0, end_ms=1200),
            ShotSpan(shot_id=2, start_ms=1200, end_ms=1800),
            ShotSpan(shot_id=3, start_ms=1800, end_ms=3000),
        ),
    )

    assert ids(rows) == [["S1-1", "S1-2", "S3-1"]]


def test_each_structural_level_samples_on_its_own() -> None:
    rows = (
        (ShotSpan(shot_id=1, start_ms=0, end_ms=1000),),
        (ShotSpan(shot_id=2, start_ms=1000, end_ms=2000),),
    )

    assert ids(rows) == [["S1-1"], ["S2-1"]]


def test_a_nonpositive_shot_is_rejected() -> None:
    rows = ((ShotSpan(shot_id=1, start_ms=1000, end_ms=1000),),)

    with pytest.raises(ValueError, match="时长必须为正"):
        sample_rows(rows)
