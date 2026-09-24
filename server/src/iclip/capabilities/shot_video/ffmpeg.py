"""分镜取帧专用的 ffmpeg 操作：整片抽帧、灰度检测与按格裁剪。

下载、探时长、可用性检查与子进程封装是通用的，调用方直接用
[platform.media.ffmpeg](../../platform/media/ffmpeg.py)。"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from tempfile import TemporaryDirectory

from iclip.capabilities.shot_video.grid import GrayImage, parse_pgm
from iclip.platform.media.ffmpeg import PROBE_TIMEOUT_SECONDS, MediaError, run

EXTRACT_TIMEOUT_SECONDS = 900.0
"""全片解码抽帧的超时上限。"""

CROP_TIMEOUT_SECONDS = 120.0

DETECT_WIDTH = 640
"""网格检测的降采样宽度；裁剪仍使用原图，输出画质不受检测分辨率影响。"""


async def extract_frames(path: Path, *, fps: float, out_dir: Path) -> list[Path]:
    """按固定帧率抽帧并返回时间升序的路径；第 i 帧对应 i / fps 秒，避免全量载入内存。"""

    if fps <= 0:
        raise MediaError(f"抽帧帧率必须为正: {fps}")
    await run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-vf",
            f"fps={fps}",
            "-q:v",
            "2",
            "-f",
            "image2",
            str(out_dir / "f%06d.jpg"),
        ],
        timeout=EXTRACT_TIMEOUT_SECONDS,
    )
    frames = sorted(out_dir.glob("f*.jpg"))
    if not frames:
        raise MediaError(f"整片抽帧没产出任何帧: {path.name}")
    return frames


async def decode_gray(path: Path, *, max_width: int = DETECT_WIDTH) -> tuple[GrayImage, int]:
    """解码降采样灰度图并返回原图宽度，供 grid.scale_box 还原裁剪坐标。"""

    stdout = await run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-frames:v",
            "1",
            # 只在图比 max_width 宽时才缩（-1 保持比例，2 的倍数对齐）。
            "-vf",
            f"scale='min({max_width},iw)':-2,format=gray",
            "-f",
            "image2",
            "-c:v",
            "pgm",
            "pipe:1",
        ],
        timeout=CROP_TIMEOUT_SECONDS,
    )
    return parse_pgm(stdout), await _image_width(path)


async def _image_width(path: Path) -> int:
    stdout = await run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    text = stdout.decode(errors="replace").strip()
    try:
        width = int(text)
    except ValueError as exc:
        raise MediaError(f"ffprobe 报的图宽看不懂: {text!r}") from exc
    if width <= 0:
        raise MediaError(f"ffprobe 报的图宽不是正数: {width}")
    return width


async def crop_cells(path: Path, boxes: Sequence[tuple[int, int, int, int]]) -> list[bytes]:
    """使用一次 filter_complex 解码并裁剪多个矩形，返回 JPEG 文件，避免重复解码。"""

    if not boxes:
        raise MediaError("没有要裁的区域")
    with TemporaryDirectory(prefix="shot-video-cells-") as tmp:
        out_dir = Path(tmp)
        chains = ";".join(
            f"[0:v]crop={w}:{h}:{x}:{y}[c{index}]" for index, (x, y, w, h) in enumerate(boxes)
        )
        args = ["ffmpeg", "-v", "error", "-y", "-i", str(path), "-filter_complex", chains]
        for index in range(len(boxes)):
            args += [
                "-map",
                f"[c{index}]",
                "-frames:v",
                "1",
                "-q:v",
                "2",
                str(out_dir / f"c{index}.jpg"),
            ]
        await run(args, timeout=CROP_TIMEOUT_SECONDS)
        cells: list[bytes] = []
        for index in range(len(boxes)):
            cell = out_dir / f"c{index}.jpg"
            if not cell.is_file() or cell.stat().st_size == 0:
                raise MediaError(f"第 {index + 1} 格裁出来是空的")
            cells.append(cell.read_bytes())
    return cells


__all__ = [
    "DETECT_WIDTH",
    "EXTRACT_TIMEOUT_SECONDS",
    "crop_cells",
    "decode_gray",
    "extract_frames",
]
