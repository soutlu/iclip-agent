"""异步媒体下载与 ffmpeg/ffprobe 子进程封装，以及视频裁剪与拼接。

子进程设定超时，超时后先 kill 再 wait，避免阻塞事件循环或遗留僵尸进程。
按格取帧、灰度检测那些只有分镜取帧用得上的操作留在 capabilities 里。"""

from __future__ import annotations

import asyncio
import json
import shutil
from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx

_STDERR_LIMIT = 400
_DOWNLOAD_CHUNK = 256 * 1024

PROBE_TIMEOUT_SECONDS = 30.0
CUT_TIMEOUT_SECONDS = 120.0
"""按关键帧裁一段不重编码，耗时只有 IO。"""

ENCODE_TIMEOUT_SECONDS = 900.0
"""拼接要整条重编码的超时上限。"""

DOWNLOAD_TIMEOUT_SECONDS = 300.0

MAX_VIDEO_BYTES = 512 * 1024 * 1024
MAX_IMAGE_BYTES = 64 * 1024 * 1024
"""下载大小上限，限制 worker 的内存与临时文件占用。"""

_VIDEO_CODEC = ("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p")
"""重编码目标：H.264 视觉无损档，浏览器与上游都认。"""

_AUDIO_CODEC = ("-c:a", "aac", "-b:a", "192k")
_AUDIO_RATE = 48000
_AUDIO_LAYOUT = "stereo"


class MediaError(RuntimeError):
    """取素材或 ffmpeg 处理失败。"""


@dataclass(frozen=True, slots=True)
class VideoProfile:
    """一条视频的画面参数。拼接必须重编码，各段就靠它对齐。"""

    width: int
    height: int
    frame_rate: str
    """ffprobe 的分数写法，如 ``30000/1001``；原样交给 fps 滤镜。"""

    has_audio: bool


@dataclass(frozen=True, slots=True)
class MediaCut:
    """从一条素材里取 ``[start, end)`` 这一段。"""

    source: Path
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def ffmpeg_available() -> bool:
    """PATH 上同时有 ffmpeg 和 ffprobe。"""

    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@asynccontextmanager
async def fetched(
    client: httpx.AsyncClient, url: str, *, max_bytes: int, suffix: str = ""
) -> AsyncGenerator[Path]:
    """将素材流式下载到临时文件供 ffmpeg seek，退出上下文时清理目录。"""

    with TemporaryDirectory(prefix="iclip-media-") as tmp:
        target = Path(tmp) / f"source{suffix}"
        await download(client, url, target, max_bytes=max_bytes)
        yield target


async def download(client: httpx.AsyncClient, url: str, dest: Path, *, max_bytes: int) -> None:
    """流式下载到指定路径并限制总字节数；要几份素材放同一个临时目录时用它。"""

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

    stdout = await run(
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


async def probe_video(path: Path) -> VideoProfile:
    """读画幅、帧率与有没有音轨。"""

    stdout = await run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height,r_frame_rate",
            "-of",
            "json",
            str(path),
        ],
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    try:
        streams = json.loads(stdout)["streams"]
    except (ValueError, KeyError, TypeError) as exc:
        raise MediaError("ffprobe 的流信息看不懂") from exc
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    if video is None:
        raise MediaError(f"这条素材里没有视频流: {path.name}")
    width, height = video.get("width"), video.get("height")
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise MediaError(f"ffprobe 报的画幅看不懂: {width!r}×{height!r}")
    rate = video.get("r_frame_rate")
    if not isinstance(rate, str) or not _positive_fraction(rate):
        raise MediaError(f"ffprobe 报的帧率看不懂: {rate!r}")
    return VideoProfile(
        width=width,
        height=height,
        frame_rate=rate,
        has_audio=any(item.get("codec_type") == "audio" for item in streams),
    )


def _positive_fraction(value: str) -> bool:
    numerator, _, denominator = value.partition("/")
    try:
        return float(numerator) > 0 and float(denominator or 1) > 0
    except ValueError:
        return False


async def cut_copy(cut: MediaCut, *, dest: Path) -> None:
    """裁出一段，不重编码。

    ``-c copy`` 只能在关键帧处下刀：起点会落到 ``start`` 之前最近的那个关键帧，产物因此
    比请求的区间长，多出来的主要在开头；``-t`` 按解码顺序截，尾部也会因 B 帧延迟多出几帧。
    调用方按产物实际时长反算的起点是差几帧的近似值，不在这里为对齐再解一遍码。"""

    _check_cut(cut)
    await run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-ss",
            f"{cut.start:.3f}",
            "-i",
            str(cut.source),
            "-t",
            f"{cut.duration:.3f}",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            "-movflags",
            "+faststart",
            str(dest),
        ],
        timeout=CUT_TIMEOUT_SECONDS,
    )
    _check_output(dest)


async def cut_concat(cuts: Sequence[MediaCut], *, profile: VideoProfile, dest: Path) -> None:
    """按顺序裁出各段并拼成一条，一次解码重编码对齐到 ``profile``。

    各段来自不同素材、参数互不相同，所以走 ``concat`` 滤镜而不是 concat 分离器——后者要求
    各输入参数一致。``profile`` 要音轨而某一段没有时，那一段配一条等长静音。

    哪几段没有音轨在这里自己探一遍（每个源几十毫秒），不要调用方随 ``MediaCut`` 带进来：
    那会把「记住各段有没有音轨」变成调用方的义务，记错就是一条拼不出来的滤镜图。"""

    if not cuts:
        raise MediaError("没有要拼的片段")
    for cut in cuts:
        _check_cut(cut)
    silent = [not (await probe_video(cut.source)).has_audio for cut in cuts]

    inputs: list[str] = []
    chains: list[str] = []
    labels: list[str] = []
    for index, cut in enumerate(cuts):
        inputs += ["-i", str(cut.source)]
        chains.append(
            f"[{index}:v]trim=start={cut.start:.3f}:end={cut.end:.3f},setpts=PTS-STARTPTS,"
            f"scale={profile.width}:{profile.height}:force_original_aspect_ratio=decrease,"
            f"pad={profile.width}:{profile.height}:(ow-iw)/2:(oh-ih)/2,"
            f"fps={profile.frame_rate},format=yuv420p,setsar=1[v{index}]"
        )
        labels.append(f"[v{index}]")

    if profile.has_audio:
        for index, cut in enumerate(cuts):
            if silent[index]:
                # 静音源单独进一路 anullsrc，长度按这一段裁好，concat 才对得齐。
                source = f"[{len(cuts) + silent[:index].count(True)}:a]"
                inputs += [
                    "-f",
                    "lavfi",
                    "-t",
                    f"{cut.duration:.3f}",
                    "-i",
                    f"anullsrc=channel_layout={_AUDIO_LAYOUT}:sample_rate={_AUDIO_RATE}",
                ]
                chains.append(f"{source}asetpts=PTS-STARTPTS[a{index}]")
            else:
                chains.append(
                    f"[{index}:a]atrim=start={cut.start:.3f}:end={cut.end:.3f},"
                    f"asetpts=PTS-STARTPTS,"
                    f"aformat=sample_rates={_AUDIO_RATE}:channel_layouts={_AUDIO_LAYOUT}[a{index}]"
                )
            labels.insert(2 * index + 1, f"[a{index}]")

    chains.append(
        f"{''.join(labels)}concat=n={len(cuts)}:v=1:a={1 if profile.has_audio else 0}"
        f"[outv]{'[outa]' if profile.has_audio else ''}"
    )
    args = ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(chains)]
    args += ["-map", "[outv]"]
    if profile.has_audio:
        args += ["-map", "[outa]", *_AUDIO_CODEC]
    args += [*_VIDEO_CODEC, "-movflags", "+faststart", str(dest)]
    await run(args, timeout=ENCODE_TIMEOUT_SECONDS)
    _check_output(dest)


def _check_cut(cut: MediaCut) -> None:
    if not cut.source.is_file():
        raise MediaError(f"要裁的素材不在: {cut.source.name}")
    if cut.start < 0 or cut.duration <= 0:
        raise MediaError(f"片段区间无效: [{cut.start}, {cut.end})")


def _check_output(dest: Path) -> None:
    if not dest.is_file() or dest.stat().st_size == 0:
        raise MediaError(f"ffmpeg 没产出内容: {dest.name}")


async def run(args: list[str], *, timeout: float) -> bytes:
    """执行子进程并返回 stdout；超时先 kill 再 wait。"""

    # 禁止读取终端输入，避免后台进程组收到 SIGTTIN 后连同后端一起暂停。
    process = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise MediaError(f"{args[0]} 超过 {timeout:.0f} 秒还没结束") from None
    except asyncio.CancelledError:
        # 任务被取消（队列关停）时不能把 ffmpeg 留成孤儿：一次重编码能占满 CPU 十几分钟。
        process.kill()
        await process.wait()
        raise
    if process.returncode != 0:
        detail = stderr.decode(errors="replace")[:_STDERR_LIMIT]
        raise MediaError(f"{args[0]} 失败（退出码 {process.returncode}）: {detail}")
    return stdout


__all__ = [
    "CUT_TIMEOUT_SECONDS",
    "DOWNLOAD_TIMEOUT_SECONDS",
    "ENCODE_TIMEOUT_SECONDS",
    "MAX_IMAGE_BYTES",
    "MAX_VIDEO_BYTES",
    "PROBE_TIMEOUT_SECONDS",
    "MediaCut",
    "MediaError",
    "VideoProfile",
    "cut_concat",
    "cut_copy",
    "download",
    "fetched",
    "ffmpeg_available",
    "probe_duration_ms",
    "probe_video",
    "run",
]
