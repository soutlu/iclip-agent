"""用真实 ffmpeg 合成素材，验证裁剪与拼接的产物、存放前缀与取不到素材时的收尾。

参考片段由 ffmpeg 自己发 http 请求按需读，httpx 替身拦不到，所以那几个用例起一个真服务
（tests.helpers.media_server）；成片仍是先下到本地，继续用替身喂字节。"""

from __future__ import annotations

import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import pytest

from iclip.domains.generation.clip import FfmpegClipProvider
from iclip.domains.generation.provider import ProviderError
from iclip.platform.media.ffmpeg import (
    ffmpeg_available,
    probe_duration_ms,
    probe_video,
)
from tests.helpers.generation import MemoryObjectStore, clip_request, make_job
from tests.helpers.media_server import serving

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

BASE_URL = "https://example.test/base.mp4"
EDITED_URL = "https://example.test/edited.mp4"


def _synthesize(path: Path, *, size: str, seconds: int, audio: bool) -> bytes:
    """合成一段图样视频。关键帧每秒一个，裁剪落到的边界才可预期。"""

    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=10"]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-c:a", "aac"]
    args += ["-t", str(seconds), "-g", "10", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(args, check=True, capture_output=True)
    return path.read_bytes()


def _synthesize_noise(path: Path, *, seconds: int) -> bytes:
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


def _client(payloads: dict[str, bytes]) -> httpx.MockTransport:
    """固定地址返回固定字节，保留真实的流式下载路径。"""

    def handler(request: httpx.Request) -> httpx.Response:
        body = payloads.get(str(request.url))
        if body is None:
            return httpx.Response(404)
        return httpx.Response(200, content=body, headers={"content-type": "video/mp4"})

    return httpx.MockTransport(handler)


@pytest.fixture
def sources() -> dict[str, bytes]:
    with TemporaryDirectory(prefix="clip-fixture-") as tmp:
        root = Path(tmp)
        return {
            BASE_URL: _synthesize(root / "base.mp4", size="320x240", seconds=4, audio=True),
            # 照实测：模型还回来的片段比原片大（720×960 进去，834×1112 出来），同比例。
            EDITED_URL: _synthesize(root / "edited.mp4", size="480x360", seconds=2, audio=False),
        }


async def _submit(
    provider: FfmpegClipProvider, store: MemoryObjectStore, **request_kwargs: object
) -> tuple[str, bytes]:
    """跑一次加工，返回落库的对象 key 与产物字节。"""

    submission = await provider.submit(make_job(clip_request(**request_kwargs), provider="ffmpeg"))

    assert submission.output_url is not None, "本地加工一次出结果，没有轮询阶段"
    key = next(iter(store.objects))
    return key, store.objects[key][0]


async def _render(
    request_kwargs: dict[str, object], sources: dict[str, bytes]
) -> tuple[str, bytes]:
    """跑一次成片加工：素材由 httpx 替身喂。"""

    store = MemoryObjectStore()
    provider = FfmpegClipProvider(object_store=store, transport=_client(sources))
    return await _submit(provider, store, **request_kwargs)


async def _duration_seconds(content: bytes) -> float:
    with TemporaryDirectory(prefix="clip-probe-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        return await probe_duration_ms(path) / 1000


async def test_reference_cut_lands_under_the_expiring_prefix(sources: dict[str, bytes]) -> None:
    store = MemoryObjectStore()
    provider = FfmpegClipProvider(object_store=store)
    async with serving({"base.mp4": sources[BASE_URL]}) as server:
        key, content = await _submit(
            provider, store, segments=[{"url": server.url("base.mp4"), "start": 1, "end": 2}]
        )

    assert key.startswith("iclip/agent/video-clips/"), "参考片段是中间素材，按前缀配过期"
    seconds = await _duration_seconds(content)
    # -c copy 只能在关键帧处下刀，产物不短于请求的区间，最多多出一个 GOP（这里 1 秒）。
    assert 1.0 <= seconds <= 2.1, seconds


async def test_reference_cut_reads_the_index_and_the_selection_only() -> None:
    """按需读：源只传了索引加选区那一段，不是整份。

    素材用不可压缩的噪声，几十兆才看得出差别——图样视频压完只有几百 KB，一次读就全拿走了。"""

    with TemporaryDirectory(prefix="clip-fixture-") as tmp:
        body = _synthesize_noise(Path(tmp) / "noise.mp4", seconds=4)
    store = MemoryObjectStore()
    provider = FfmpegClipProvider(object_store=store)
    async with serving({"noise.mp4": body}) as server:
        _, content = await _submit(
            provider, store, segments=[{"url": server.url("noise.mp4"), "start": 3, "end": 4}]
        )
        sent, requests = server.sent, server.range_requests

    assert requests >= 1, "ffmpeg 应该带着 Range 去读"
    assert sent < len(body) * 0.6, f"只该取索引与选区，却传了 {sent} / {len(body)}"
    assert 1.0 <= await _duration_seconds(content) <= 2.1


async def test_reference_cut_still_works_when_the_source_ignores_range(
    sources: dict[str, bytes],
) -> None:
    """源不支持 Range 时退化为顺序读：慢，但 moov 在头部仍出正确产物。"""

    store = MemoryObjectStore()
    provider = FfmpegClipProvider(object_store=store)
    async with serving({"base.mp4": sources[BASE_URL]}, ranges=False) as server:
        _, content = await _submit(
            provider, store, segments=[{"url": server.url("base.mp4"), "start": 1, "end": 2}]
        )

    assert 1.0 <= await _duration_seconds(content) <= 2.1


async def test_reference_cut_fails_without_retry_when_the_source_is_gone() -> None:
    """签名过期、对象没了都归这一档：读取与裁剪交错，分不出取素材和加工两步。"""

    provider = FfmpegClipProvider(object_store=MemoryObjectStore())
    async with serving({}) as server:
        job = make_job(
            clip_request(segments=[{"url": server.url("gone.mp4"), "start": 1, "end": 2}]),
            provider="ffmpeg",
        )
        with pytest.raises(ProviderError) as caught:
            await provider.submit(job)

    assert caught.value.code == "MEDIA_PROCESS_FAILED"
    assert not caught.value.retryable, "取不到素材是这次请求的问题，重排也还是取不到"


async def test_master_concat_aligns_to_the_original_and_keeps_total_length(
    sources: dict[str, bytes],
) -> None:
    """换进去的那段画幅更大，成片仍照原片——原片贡献的时长更长。"""

    key, content = await _render(
        {
            "purpose": "master",
            "segments": [
                {"url": BASE_URL, "start": 0, "end": 1},
                {"url": EDITED_URL, "start": 0.3, "end": 1.7},
                {"url": BASE_URL, "start": 3, "end": 4},
            ],
        },
        sources,
    )

    assert key.startswith("iclip/agent/video-masters/"), "成片长期保留，不进过期规则"
    assert 3.1 <= await _duration_seconds(content) <= 3.7, "总长是各段之和"
    with TemporaryDirectory(prefix="clip-probe-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        profile = await probe_video(path)
    assert (profile.width, profile.height) == (320, 240), (
        "对齐到原片；照「画幅最大的那条」会变成 480×360"
    )
    assert profile.has_audio, "有一段带音轨就出音轨，没音轨的那段补静音"


async def test_master_still_aligns_to_the_original_when_the_edit_covers_most_of_it(
    sources: dict[str, bytes],
) -> None:
    """编辑区间超过一半：换进去的那段在成片里占大头，成片仍照原片——原片整条更长。"""

    _, content = await _render(
        {
            "purpose": "master",
            "segments": [
                {"url": BASE_URL, "start": 0, "end": 0.5},
                {"url": EDITED_URL, "start": 0, "end": 2},
                {"url": BASE_URL, "start": 3.5, "end": 4},
            ],
        },
        sources,
    )

    with TemporaryDirectory(prefix="clip-probe-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        profile = await probe_video(path)
    assert (profile.width, profile.height) == (320, 240), (
        "按贡献时长认原片会认成 480×360 的编辑片段"
    )


async def test_master_source_that_cannot_be_fetched_fails_without_retry() -> None:
    """成片仍是先下到本地，取不到素材有自己的错误码。"""

    provider = FfmpegClipProvider(object_store=MemoryObjectStore(), transport=_client({}))
    job = make_job(
        clip_request(
            purpose="master",
            segments=[
                {"url": BASE_URL, "start": 0, "end": 1},
                {"url": EDITED_URL, "start": 0, "end": 1},
            ],
        ),
        provider="ffmpeg",
    )

    with pytest.raises(ProviderError) as caught:
        await provider.submit(job)

    assert caught.value.code == "MEDIA_SOURCE_UNREACHABLE"
    assert not caught.value.retryable, "取不到素材是这次请求的问题，重排也还是取不到"
