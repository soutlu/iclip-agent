"""从拆解文档解析镜头区间，并在全片铺等间隔采样点。纯计算、零 I/O。

同一份拆解文档必产出同一份候选帧，所以取帧能按内容做幂等复用。
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

SHOT_TIMECODE_SHAPE = "**[MM:SS.mmm-MM:SS.mmm]**"
FRAME_INTERVAL_MS = 1000
CELL_ID_SHAPE = "S<镜头号>-<序号>"

_SHOT_MARKER_RE = re.compile(r"\*\*\s*\[([^\]\n]*)\]\s*\*\*")
_TIMECODE = r"(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?"
_SHOT_RANGE_RE = re.compile(_TIMECODE + r"\s*-\s*" + _TIMECODE)
_CELL_ID_RE = re.compile(r"^S(\d+)-(\d+)$")

# NFKC 已经覆盖全角数字、全角冒号与不间断空格；破折号族和零宽字符没有 NFKC
# 映射，得单列。
_DASH_VARIANTS = {ord(char): "-" for char in "~–—−"}
_BLANK_VARIANTS = dict.fromkeys(map(ord, "​‌‍﻿"), None)


class ShotParseError(ValueError):
    """拆解文档里读不出镜头时间码。"""


@dataclass(frozen=True, slots=True)
class ShotSpan:
    """一个镜头的时间区间，半开区间 ``[start_ms, end_ms)``。"""

    shot_id: int
    start_ms: int
    end_ms: int

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass(frozen=True, slots=True)
class SampledCell:
    """一个候选帧。``cell_id`` 是模型引用这一格的唯一凭据。"""

    cell_id: str
    shot_id: int
    src_ms: int


def parse_shot_rows(markdown: str) -> tuple[tuple[ShotSpan, ...], ...]:
    """按结构层级分组解析逐镜时间区间。

    一个物理行就是拆解文档第 4 节表格的一行，也就是一个结构层级；分组只决定
    预览板怎么分板。``shot_id`` 取全文档顺序，与分组无关。

    只归一同一个值的不同写法，不推断缺失或有歧义的部分——在这里猜出来的时间戳
    没人能复核，错了就是无声的错帧。
    """

    rows: list[tuple[ShotSpan, ...]] = []
    shot_id = 0
    for line in markdown.splitlines():
        spans: list[ShotSpan] = []
        for marker in _SHOT_MARKER_RE.finditer(line):
            raw = marker.group(1).strip()
            matched = _SHOT_RANGE_RE.fullmatch(_normalized(raw))
            if matched is None:
                raise ShotParseError(f"镜头标记 {raw!r} 不是 {SHOT_TIMECODE_SHAPE} 形状的时间码")
            start_ms = _timecode_ms(*matched.group(1, 2, 3, 4))
            end_ms = _timecode_ms(*matched.group(5, 6, 7, 8))
            if end_ms <= start_ms:
                raise ShotParseError(f"镜头标记 {raw!r} 的终点不晚于起点")
            shot_id += 1
            spans.append(ShotSpan(shot_id=shot_id, start_ms=start_ms, end_ms=end_ms))
        if spans:
            rows.append(tuple(spans))
    if not rows:
        raise ShotParseError(f"找不到 {SHOT_TIMECODE_SHAPE} 形状的镜头时间码标记")
    return tuple(rows)


def sample_rows(
    rows: Sequence[Sequence[ShotSpan]], *, interval_ms: int = FRAME_INTERVAL_MS
) -> tuple[tuple[SampledCell, ...], ...]:
    """在全片铺 ``0, interval, 2*interval, …`` 的采样栅格，每点落进覆盖它的镜头。

    栅格是全片统一的，不按镜头对齐：改了镜头切分，已有候选帧不会整体位移。栅格
    点即源帧下标，所以候选帧一律从这份等间隔帧里取。

    短于一个间隔又不含栅格点的镜头没有候选帧，由调用方点名——补中点会得到一个
    不在栅格上的时间戳，取不到对应源帧。
    """

    if interval_ms <= 0:
        raise ValueError(f"采样间隔必须为正: {interval_ms}")
    sampled: list[tuple[SampledCell, ...]] = []
    for row in rows:
        cells: list[SampledCell] = []
        for shot in row:
            if shot.duration_ms <= 0:
                raise ValueError(f"镜头 {shot.shot_id} 时长必须为正")
            first = -(-shot.start_ms // interval_ms) * interval_ms
            cells.extend(
                SampledCell(cell_id=f"S{shot.shot_id}-{index}", shot_id=shot.shot_id, src_ms=src_ms)
                for index, src_ms in enumerate(range(first, shot.end_ms, interval_ms), start=1)
            )
        sampled.append(tuple(cells))
    return tuple(sampled)


def parse_cell_id(cell_id: str) -> tuple[int, int]:
    """解析帧号，返回 ``(镜头号, 序号)``。"""

    matched = _CELL_ID_RE.fullmatch(cell_id.strip())
    if matched is None:
        raise ShotParseError(f"帧号 {cell_id!r} 不是 {CELL_ID_SHAPE} 形状")
    return int(matched.group(1)), int(matched.group(2))


def extraction_key(*, video_hash: str, rows: Sequence[Sequence[ShotSpan]], interval_ms: int) -> str:
    """取帧幂等键。

    取帧只依赖视频内容、镜头区间与采样间隔；参考图、全局参考设定与画幅是生成层
    的输入，不进这个键。
    """

    payload = json.dumps(
        {
            "videoHash": video_hash,
            "rows": [[[s.shot_id, s.start_ms, s.end_ms] for s in row] for row in rows],
            "intervalMs": interval_ms,
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _normalized(payload: str) -> str:
    text = unicodedata.normalize("NFKC", payload).translate(_BLANK_VARIANTS)
    return text.translate(_DASH_VARIANTS).strip()


def _timecode_ms(hours: str | None, minutes: str, seconds: str, millis: str | None) -> int:
    """``[HH:]MM:SS[.mmm]`` → 毫秒；毫秒不足三位按右侧补零。"""

    return ((int(hours or 0) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + int(
        (millis or "0").ljust(3, "0")
    )


__all__ = [
    "CELL_ID_SHAPE",
    "FRAME_INTERVAL_MS",
    "SHOT_TIMECODE_SHAPE",
    "SampledCell",
    "ShotParseError",
    "ShotSpan",
    "extraction_key",
    "parse_cell_id",
    "parse_shot_rows",
    "sample_rows",
]
