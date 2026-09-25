"""用真实 ffmpeg 合成素材，验证合成的产物、存放前缀、阶段上报与取不到素材时的收尾。

合成先把素材下到本地，httpx 替身喂字节就够；切参考片段是 ffmpeg 自己按需远程读，在
``test_reference_cutter.py``。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest

from iclip.domains.generation.clip import FfmpegClipProvider
from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.schemas import ClipStage
from iclip.platform.media.ffmpeg import ffmpeg_available, probe_video
from tests.helpers.generation import MemoryObjectStore, compose_request, make_job
from tests.helpers.media import duration_ms_of, synthesize_video

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

BASE_URL = "https://example.test/base.mp4"
EDITED_URL = "https://example.test/edited.mp4"


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
            BASE_URL: synthesize_video(root / "base.mp4", size="320x240", seconds=4, audio=True),
            # 照实测：模型还回来的片段比原片大（720×960 进去，834×1112 出来），同比例。
            EDITED_URL: synthesize_video(
                root / "edited.mp4", size="480x360", seconds=2, audio=False
            ),
        }


@dataclass
class _Stages:
    """记下 provider 报了哪些阶段。

    ``live=False`` 模拟这条任务已经不在提交中；``broken`` 模拟写库失败。"""

    seen: list[ClipStage] = field(default_factory=list)
    live: bool = True
    broken: bool = False

    async def report(self, job_id: uuid.UUID, stage: ClipStage) -> bool:
        self.seen.append(stage)
        if self.broken:
            raise RuntimeError("数据库连接抖了一下")
        return self.live


async def _compose(
    segments: list[dict[str, Any]],
    sources: dict[str, bytes],
    *,
    stages: _Stages | None = None,
) -> tuple[str, bytes]:
    """跑一次合成，返回落库的对象 key 与产物字节。"""

    store = MemoryObjectStore()
    provider = FfmpegClipProvider(
        object_store=store, report_stage=(stages or _Stages()).report, transport=_client(sources)
    )
    submission = await provider.submit(
        make_job(compose_request(segments=segments), provider="ffmpeg")
    )

    assert submission.output_url is not None, "本地加工一次出结果，没有轮询阶段"
    key, (content, _) = next(iter(store.objects.items()))
    assert submission.raw == {"durationMs": await duration_ms_of(content)}, "快照只带量出来的时长"
    return key, content


async def _profile(content: bytes) -> tuple[int, int, bool]:
    with TemporaryDirectory(prefix="clip-probe-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        profile = await probe_video(path)
    return profile.width, profile.height, profile.has_audio


async def test_a_composite_aligns_to_the_original_and_keeps_total_length(
    sources: dict[str, bytes],
) -> None:
    """换进去的那段画幅更大，成片仍照原片——原片整条更长。"""

    key, content = await _compose(
        [
            {"url": BASE_URL, "start": 0, "end": 1},
            {"url": EDITED_URL, "start": 0.3, "end": 1.7},
            {"url": BASE_URL, "start": 3, "end": 4},
        ],
        sources,
    )

    assert key.startswith("iclip/agent/video-masters/"), "成片长期保留，不进过期规则"
    assert 3100 <= await duration_ms_of(content) <= 3700, "总长是各段之和"
    assert await _profile(content) == (320, 240, True), (
        "对齐到原片；有一段带音轨就出音轨，没音轨的那段补静音"
    )


async def test_a_composite_still_aligns_to_the_original_when_the_edit_covers_most_of_it(
    sources: dict[str, bytes],
) -> None:
    """编辑区间超过一半：换进去的那段在成片里占大头，成片仍照原片。"""

    _, content = await _compose(
        [
            {"url": BASE_URL, "start": 0, "end": 0.5},
            {"url": EDITED_URL, "start": 0, "end": 2},
            {"url": BASE_URL, "start": 3.5, "end": 4},
        ],
        sources,
    )

    width, height, _ = await _profile(content)
    assert (width, height) == (320, 240), "按贡献时长认原片会认成 480×360 的编辑片段"


async def test_open_ends_are_filled_from_the_downloaded_sources(
    sources: dict[str, bytes],
) -> None:
    """编辑段产物整条、基底后段取到结尾：长度按下载下来的素材补齐。"""

    _, content = await _compose(
        [
            {"url": BASE_URL, "start": 0, "end": 1},
            {"url": EDITED_URL, "start": 0},
            {"url": BASE_URL, "start": 3},
        ],
        sources,
    )

    assert 3800 <= await duration_ms_of(content) <= 4200, "1 秒前段 + 2 秒编辑段 + 1 秒后段"


async def test_a_tail_that_starts_at_the_end_of_the_base_is_skipped(
    sources: dict[str, bytes],
) -> None:
    """编辑一直改到基底结尾，后段从结尾取到结尾，是空的：跳过而不是报零长段。"""

    base_ms = await duration_ms_of(sources[BASE_URL])
    _, content = await _compose(
        [
            {"url": BASE_URL, "start": 0, "end": 2},
            {"url": EDITED_URL, "start": 0},
            {"url": BASE_URL, "start": base_ms / 1000},
        ],
        sources,
    )

    assert 3800 <= await duration_ms_of(content) <= 4200, "2 秒前段 + 2 秒编辑段"


async def test_a_composite_reports_fetching_then_processing_then_uploading(
    sources: dict[str, bytes],
) -> None:
    """三步都有：下素材、探规格算取素材，重编码算加工。"""

    stages = _Stages()
    await _compose(
        [{"url": BASE_URL, "start": 0, "end": 1}, {"url": EDITED_URL, "start": 0}],
        sources,
        stages=stages,
    )

    assert stages.seen == ["fetching", "processing", "uploading"]


async def test_stops_reporting_once_the_job_has_a_conclusion_but_still_finishes(
    sources: dict[str, bytes],
) -> None:
    """上报被拒（这条已经有结论了）就不再报，活照样干完——产物落在按任务 id 定好的 key 上。"""

    stages = _Stages(live=False)
    key, content = await _compose(
        [{"url": BASE_URL, "start": 0, "end": 1}, {"url": EDITED_URL, "start": 0}],
        sources,
        stages=stages,
    )

    assert stages.seen == ["fetching"], "第一次就被拒，后面不再报"
    assert key.startswith("iclip/agent/video-masters/")
    assert await duration_ms_of(content) > 0


async def test_a_broken_stage_report_does_not_fail_the_job(sources: dict[str, bytes]) -> None:
    """阶段词只是给人看的：写不进去就不写了。

    让它抛出去会穿过队列的 ProviderError 捕获进重试策略，下一次执行见 submitting 就判
    SUBMIT_INTERRUPTED——一条能出结果的加工被一次展示用的写库失败判死。"""

    stages = _Stages(broken=True)
    _, content = await _compose(
        [{"url": BASE_URL, "start": 0, "end": 1}, {"url": EDITED_URL, "start": 0}],
        sources,
        stages=stages,
    )

    assert stages.seen == ["fetching"], "第一次就炸，后面不再报"
    assert await duration_ms_of(content) > 0


async def test_a_source_that_cannot_be_fetched_fails_without_retry() -> None:
    """先下到本地，取不到素材有自己的错误码。"""

    provider = FfmpegClipProvider(
        object_store=MemoryObjectStore(), report_stage=_Stages().report, transport=_client({})
    )
    job = make_job(
        compose_request(
            segments=[{"url": BASE_URL, "start": 0, "end": 1}, {"url": EDITED_URL, "start": 0}]
        ),
        provider="ffmpeg",
    )

    with pytest.raises(ProviderError) as caught:
        await provider.submit(job)

    assert caught.value.code == "MEDIA_SOURCE_UNREACHABLE"
    assert not caught.value.retryable, "取不到素材是这次请求的问题，重排也还是取不到"
