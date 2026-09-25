"""用真实 ffmpeg 与本地 HTTP 服务，验证编辑段的参考片段怎么切、存哪、记下哪段区间。

ffmpeg 自己发 http 请求按需读基底，httpx 替身拦不到，所以起一个真服务（tests.helpers.media_server）。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from iclip.domains.generation.clip import ReferenceCut, ReferenceCutter
from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.schemas import ClipStage
from iclip.platform.media.ffmpeg import ffmpeg_available
from tests.helpers.generation import MemoryObjectStore
from tests.helpers.media import duration_ms_of, synthesize_noise, synthesize_video
from tests.helpers.media_server import serving

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]


@pytest.fixture(scope="module")
def base() -> bytes:
    """4 秒的基底，关键帧每秒一个，moov 在尾部。"""

    with TemporaryDirectory(prefix="cutter-fixture-") as tmp:
        return synthesize_video(Path(tmp) / "base.mp4", size="320x240", seconds=4, audio=True)


@dataclass
class _Stages:
    seen: list[ClipStage] = field(default_factory=list)

    async def report(self, job_id: uuid.UUID, stage: ClipStage) -> bool:
        self.seen.append(stage)
        return True


async def _cut(
    body: bytes,
    *,
    start_ms: int,
    end_ms: int,
    ranges: bool = True,
    stages: _Stages | None = None,
) -> tuple[uuid.UUID, ReferenceCut, MemoryObjectStore]:
    store = MemoryObjectStore()
    cutter = ReferenceCutter(object_store=store, report_stage=(stages or _Stages()).report)
    job_id = uuid.uuid4()
    async with serving({"base.mp4": body}, ranges=ranges) as server:
        cut = await cutter.cut(
            job_id=job_id, source_url=server.url("base.mp4"), start_ms=start_ms, end_ms=end_ms
        )
    return job_id, cut, store


async def test_a_cut_lands_under_the_expiring_prefix_and_records_what_the_model_sees(
    base: bytes,
) -> None:
    """起点落到之前最近的关键帧上，产物比区间长、多在开头：实际起点从终点按产物时长倒推。"""

    stages = _Stages()
    job_id, cut, store = await _cut(base, start_ms=1500, end_ms=3000, stages=stages)

    ((key, (content, _)),) = store.objects.items()
    assert key == f"iclip/agent/video-clips/{job_id}.mp4", "参考片段是中间素材，按前缀配过期"
    assert cut.url == store.public_url(key)
    clip_ms = await duration_ms_of(content)
    assert cut.end_ms == 3000
    assert cut.start_ms == cut.end_ms - clip_ms, "区间就是产物真正覆盖的那一段"
    assert cut.start_ms < 1500, "关键帧在 1 秒处，模型实际看到的从更早开始"
    assert stages.seen == ["processing", "uploading"], "边读边切，没有取素材这一步"


async def test_an_end_beyond_the_base_is_clamped_to_its_length(base: bytes) -> None:
    base_ms = await duration_ms_of(base)

    _, cut, _ = await _cut(base, start_ms=2000, end_ms=base_ms + 5000)

    assert cut.end_ms == base_ms
    assert cut.start_ms <= 2000


async def test_a_start_outside_the_base_fails_without_retry(base: bytes) -> None:
    """起点不在基底之内：没有可改的东西，这次编辑判失败，报错里说基底多长。"""

    base_ms = await duration_ms_of(base)

    with pytest.raises(ProviderError) as caught:
        await _cut(base, start_ms=base_ms, end_ms=base_ms + 1000)

    assert (caught.value.code, caught.value.retryable) == ("EDIT_RANGE_OUT_OF_BOUNDS", False)
    assert str(base_ms) in str(caught.value), "报错里带基底时长"


async def test_a_cut_reads_the_index_and_the_selection_only() -> None:
    """按需读：源只传了索引加选区那一段，不是整份。

    素材用不可压缩的噪声，几十兆才看得出差别——图样视频压完只有几百 KB，一次读就全拿走了。"""

    with TemporaryDirectory(prefix="cutter-fixture-") as tmp:
        body = synthesize_noise(Path(tmp) / "noise.mp4", seconds=4)
    store = MemoryObjectStore()
    cutter = ReferenceCutter(object_store=store, report_stage=_Stages().report)
    async with serving({"noise.mp4": body}) as server:
        cut = await cutter.cut(
            job_id=uuid.uuid4(), source_url=server.url("noise.mp4"), start_ms=3000, end_ms=4000
        )
        sent, requests = server.sent, server.range_requests

    assert requests >= 1, "ffmpeg 应该带着 Range 去读"
    assert sent < len(body) * 0.6, f"只该取索引与选区，却传了 {sent} / {len(body)}"
    assert 1000 <= cut.end_ms - cut.start_ms <= 2100


async def test_a_cut_still_works_when_the_source_ignores_range() -> None:
    """源不支持 Range 时退化为顺序读：慢，但 moov 在头部仍出正确产物。

    moov 在尾部时 ffmpeg 读到它之后要倒回 mdat，只有那段字节恰好还在读缓冲里才倒得回去，
    成败随 TCP 分包而变，不是这条用例要验证的行为。"""

    with TemporaryDirectory(prefix="cutter-fixture-") as tmp:
        body = synthesize_video(
            Path(tmp) / "base.mp4", size="320x240", seconds=4, audio=True, faststart=True
        )

    _, cut, _ = await _cut(body, start_ms=1000, end_ms=2000, ranges=False)

    assert 1000 <= cut.end_ms - cut.start_ms <= 2100


async def test_a_base_that_is_gone_fails_without_retry() -> None:
    """签名过期、对象没了：探不到基底，不去切，也不重试。"""

    store = MemoryObjectStore()
    cutter = ReferenceCutter(object_store=store, report_stage=_Stages().report)
    async with serving({}) as server:
        with pytest.raises(ProviderError) as caught:
            await cutter.cut(
                job_id=uuid.uuid4(), source_url=server.url("gone.mp4"), start_ms=1000, end_ms=2000
            )

    assert (caught.value.code, caught.value.retryable) == ("MEDIA_SOURCE_UNREACHABLE", False)
    assert store.objects == {}
