"""ffmpeg / ffprobe 子进程原语：取素材、探时长、抽帧、按矩形裁切。

全部异步起进程（同步 subprocess 会把整个 worker 的事件循环按住几十秒），每个
子进程都带超时（ffmpeg 撞上坏输入会卡死不退），超时先 kill 再 wait，不留僵尸。
"""

from __future__ import annotations

import asyncio
import shutil
from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx

from iclip.capabilities.shot_video.grid import GrayImage, parse_pgm

_STDERR_LIMIT = 400
_DOWNLOAD_CHUNK = 256 * 1024

PROBE_TIMEOUT_SECONDS = 30.0
EXTRACT_TIMEOUT_SECONDS = 900.0
"""整片按秒抽帧的上限。它要把整段视频解码一遍，和取单帧不是一个量级。"""

CROP_TIMEOUT_SECONDS = 120.0
DOWNLOAD_TIMEOUT_SECONDS = 300.0

MAX_VIDEO_BYTES = 512 * 1024 * 1024
MAX_IMAGE_BYTES = 64 * 1024 * 1024
"""下载上限。这不是安全检查（地址是可信的），是防一个超大文件把 worker 撑爆。"""

DETECT_WIDTH = 640
"""做网格检测时把图降到多宽。分隔带是大尺度结构，降采样看得见，成本低两个量级。

裁剪仍在原图上做，所以这个降采样不影响输出画质。
"""


class MediaError(RuntimeError):
    """取素材或 ffmpeg 处理失败。"""


def ffmpeg_available() -> bool:
    """PATH 上同时有 ffmpeg 和 ffprobe。"""

    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@asynccontextmanager
async def fetched(
    client: httpx.AsyncClient, url: str, *, max_bytes: int, suffix: str = ""
) -> AsyncGenerator[Path]:
    """把素材流式落到临时文件，退出上下文时连目录删掉。

    落盘而不是进内存：ffmpeg 要 seek，而一段视频动辄几百兆。
    """

    with TemporaryDirectory(prefix="shot-video-") as tmp:
        target = Path(tmp) / f"source{suffix}"
        await _download(client, url, target, max_bytes=max_bytes)
        yield target


async def _download(client: httpx.AsyncClient, url: str, dest: Path, *, max_bytes: int) -> None:
    written = 0
    try:
        async with client.stream("GET", url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            response.raise_for_status()
            with dest.open("wb") as handle:
                async for chunk in response.aiter_bytes(_DOWNLOAD_CHUNK):
                    written += len(chunk)
                    if written > max_bytes:
                        raise MediaError(f"素材超过 {max_bytes} 字节的上限: {url}")
                    handle.write(chunk)
    except httpx.HTTPError as exc:
        raise MediaError(f"取不到素材（{type(exc).__name__}）: {url}") from exc
    if written == 0:
        raise MediaError(f"取到的素材是空的: {url}")


async def probe_duration_ms(path: Path) -> int:
    """探测媒体时长（毫秒）。"""

    stdout = await _run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    text = stdout.decode(errors="replace").strip()
    try:
        seconds = float(text)
    except ValueError as exc:
        raise MediaError(f"ffprobe 报的时长看不懂: {text!r}") from exc
    if seconds <= 0:
        raise MediaError(f"ffprobe 报的时长不是正数: {seconds}")
    return round(seconds * 1000)


async def extract_frames(path: Path, *, fps: float, out_dir: Path) -> list[Path]:
    """按固定帧率整片抽帧，落进 ``out_dir``，返回按时间升序的文件路径。

    第 i 张（0 起）对应源视频 ``i / fps`` 秒处。返回路径不返回字节：一段几分钟的
    片子按秒抽就是几百张，全捧在内存里没必要。
    """

    if fps <= 0:
        raise MediaError(f"抽帧帧率必须为正: {fps}")
    await _run(
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
    """解码成降采样灰度图，并回报原图宽度（``grid.scale_box`` 靠它还原坐标）。"""

    stdout = await _run(
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
    stdout = await _run(
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
    """按矩形把一张图裁成若干张 JPEG，一趟子进程做完。

    走 ``filter_complex`` 一路输入分 N 路裁剪；每格起一个 ffmpeg 会把整图解码 N 遍。
    """

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
        await _run(args, timeout=CROP_TIMEOUT_SECONDS)
        cells: list[bytes] = []
        for index in range(len(boxes)):
            cell = out_dir / f"c{index}.jpg"
            if not cell.is_file() or cell.stat().st_size == 0:
                raise MediaError(f"第 {index + 1} 格裁出来是空的")
            cells.append(cell.read_bytes())
    return cells


async def shrink(data: bytes, *, max_edge: int) -> bytes:
    """把一张图缩到长边不超过 ``max_edge``，返回 JPEG 字节。

    只用于附给模型看的那一份：一张 4K 帧几兆字节，几张就把一次请求撑爆。
    """

    return await _run_with_input(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            "pipe:0",
            "-frames:v",
            "1",
            "-vf",
            f"scale='if(gt(iw,ih),min({max_edge},iw),-2)':'if(gt(iw,ih),-2,min({max_edge},ih))'",
            "-q:v",
            "4",
            "-f",
            "image2",
            "-c:v",
            "mjpeg",
            "pipe:1",
        ],
        stdin=data,
        timeout=CROP_TIMEOUT_SECONDS,
    )


async def _run(args: list[str], *, timeout: float) -> bytes:
    """起一个子进程，等它退出，返回 stdout。超时先 kill 再 wait，不留僵尸。"""

    process = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise MediaError(f"{args[0]} 超过 {timeout:.0f} 秒还没结束") from None
    if process.returncode != 0:
        detail = stderr.decode(errors="replace")[:_STDERR_LIMIT]
        raise MediaError(f"{args[0]} 失败（退出码 {process.returncode}）: {detail}")
    return stdout


async def _run_with_input(args: list[str], *, stdin: bytes, timeout: float) -> bytes:
    """同 ``_run``，但把字节从 stdin 喂进去。"""

    process = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(stdin), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise MediaError(f"{args[0]} 超过 {timeout:.0f} 秒还没结束") from None
    if process.returncode != 0:
        detail = stderr.decode(errors="replace")[:_STDERR_LIMIT]
        raise MediaError(f"{args[0]} 失败（退出码 {process.returncode}）: {detail}")
    if not stdout:
        raise MediaError(f"{args[0]} 没有输出")
    return stdout


__all__ = [
    "DETECT_WIDTH",
    "EXTRACT_TIMEOUT_SECONDS",
    "MAX_IMAGE_BYTES",
    "MAX_VIDEO_BYTES",
    "MediaError",
    "crop_cells",
    "decode_gray",
    "extract_frames",
    "fetched",
    "ffmpeg_available",
    "probe_duration_ms",
    "shrink",
]
