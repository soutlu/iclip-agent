"""用真实 ffmpeg 合成测试素材，供切片与合成的集成测试共用。"""

from __future__ import annotations

import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from iclip.platform.media.ffmpeg import probe_duration_ms


def synthesize_video(
    path: Path, *, size: str, seconds: int, audio: bool, faststart: bool = False
) -> bytes:
    """合成一段图样视频。关键帧每秒一个，裁剪落到的边界才可预期。

    默认照 ffmpeg 的缺省把 moov 写在尾部，和不少上传素材一样；``faststart`` 把它挪到头部。"""

    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=10"]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-c:a", "aac"]
    args += ["-t", str(seconds), "-g", "10", "-pix_fmt", "yuv420p"]
    if faststart:
        args += ["-movflags", "+faststart"]
    args.append(str(path))
    subprocess.run(args, check=True, capture_output=True)
    return path.read_bytes()


def synthesize_noise(path: Path, *, seconds: int) -> bytes:
    """合成一段随机噪声视频。压不动，所以几十兆，按需读省下多少一眼能看出来。"""

    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", "480x854", "-r", "25",
            "-i", "/dev/urandom", "-t", str(seconds),
            "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-crf", "26",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    return path.read_bytes()


async def duration_ms_of(content: bytes) -> int:
    """量一段视频字节的时长（毫秒），与服务端用的是同一个探测。"""

    with TemporaryDirectory(prefix="media-probe-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        return await probe_duration_ms(path)


__all__ = ["duration_ms_of", "synthesize_noise", "synthesize_video"]
