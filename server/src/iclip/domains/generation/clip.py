"""本地视频加工：合成成片，以及编辑段交上游前切参考片段。产物存进本系统的桶。

不经任何外部服务，一次调用出结果，没有轮询阶段，也不涉及计费——失败重发就是了。两者取素材的
方式不同：参考片段交给 ffmpeg 按需远程读一段、不重编码；合成要把几段拼起来，先下到本地、一律
重编码对齐到原片。存放前缀也不同：参考片段是中间素材，桶上按前缀过期；成片长期保留。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final

import httpx
import structlog

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
    request_of,
)
from iclip.domains.generation.schemas import (
    CLIP_FETCHING,
    CLIP_PROCESSING,
    CLIP_UPLOADING,
    ClipStage,
    ComposeSegment,
    VideoComposeRequest,
)
from iclip.platform.media.ffmpeg import (
    MAX_VIDEO_BYTES,
    MediaCut,
    MediaError,
    VideoProfile,
    cut_concat,
    cut_copy_url,
    download,
    probe_duration_ms,
    probe_remote_duration_ms,
    probe_video,
)
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable, PublicObjectStore

_logger = structlog.stdlib.get_logger(__name__)

PROVIDER_NAME: Final = "ffmpeg"

_EXT: Final = "mp4"
_CONTENT_TYPE: Final = "video/mp4"

ReportClipStage = Callable[[uuid.UUID, ClipStage], Awaitable[bool]]
"""上报一次阶段。返回 False 表示这条任务已经不在提交中，调用方不必再报。"""

_Report = Callable[[ClipStage], Awaitable[None]]
"""只服务一次加工的上报器，由 ``_stage_reporter`` 造。"""


def _stage_reporter(report_stage: ReportClipStage, job_id: uuid.UUID) -> _Report:
    """造一个只服务这一次加工的上报器。

    合成器与切片器的实例被多个任务共享，所以「还在途」这个标记留在闭包里。上报被拒之后就
    不再报，但活照样干完——产物按任务 id 落在固定的 key 上，同 key 已存在则保留先到的那份。"""

    live = True

    async def report(stage: ClipStage) -> None:
        nonlocal live
        if not live:
            return
        try:
            live = await report_stage(job_id, stage)
        except Exception as exc:
            # 阶段词只是给人看的：写不进去就不写了，不能让它把一条能出结果的加工判成失败。
            live = False
            _logger.warning("阶段上报失败，这次加工不再上报", job_id=job_id, error=str(exc))
            return
        if not live:
            _logger.info("加工任务已有结论，不再上报阶段", job_id=job_id, stage=stage)

    return report


async def _store(object_store: PublicObjectStore, key: str, content: bytes) -> str:
    """存进桶，交回公开地址；存不进去是 ``OUTPUT_STORE_FAILED``，不重试。"""

    try:
        return await object_store.put_public_object(
            object_key=key, content=content, content_type=_CONTENT_TYPE
        )
    except ObjectStoreUnavailable as exc:
        raise ProviderError(
            f"视频加工完了但存不进桶: {exc}",
            code="OUTPUT_STORE_FAILED",
            retryable=False,
        ) from exc


@dataclass(frozen=True, slots=True)
class ReferenceCut:
    """切好的参考片段：公开地址，以及它在基底上实际覆盖的区间（毫秒）。"""

    url: str
    start_ms: int
    end_ms: int


class ReferenceCutter:
    """编辑段交上游前，从基底上切出给模型看的参考片段。"""

    def __init__(self, *, object_store: PublicObjectStore, report_stage: ReportClipStage) -> None:
        """``report_stage`` 由装配注入，切片器自己不碰数据库。

        基底由 ffmpeg 自己发 http 请求按需读，httpx 替身拦不到它——测试得起一个真服务。"""

        self._object_store = object_store
        self._report_stage = report_stage

    async def cut(
        self, *, job_id: uuid.UUID, source_url: str, start_ms: int, end_ms: int
    ) -> ReferenceCut:
        """切出基底上 ``[start_ms, end_ms)`` 这一段，存到编辑段名下，交回地址与实际区间。

        起点不在基底之内是 ``EDIT_RANGE_OUT_OF_BOUNDS``；终点超过基底时长就截到时长。不重编码，
        ``-c copy`` 只能在关键帧处下刀，产物比区间长、多出来的在开头，所以实际起点按产物时长
        从终点倒推——记下的区间就是模型真正看到的那一段。取不到基底是
        ``MEDIA_SOURCE_UNREACHABLE``，切不出来是 ``MEDIA_PROCESS_FAILED``，存不进桶是
        ``OUTPUT_STORE_FAILED``，都不重试。"""

        report = _stage_reporter(self._report_stage, job_id)
        try:
            base_ms = await probe_remote_duration_ms(source_url)
        except MediaError as exc:
            raise ProviderError(
                f"取不到要编辑的基底: {exc}", code="MEDIA_SOURCE_UNREACHABLE", retryable=False
            ) from exc
        if start_ms >= base_ms:
            raise ProviderError(
                f"编辑区间从 {start_ms} 毫秒起，基底只有 {base_ms} 毫秒",
                code="EDIT_RANGE_OUT_OF_BOUNDS",
                retryable=False,
            )
        end_ms = min(end_ms, base_ms)
        # 读取与裁剪交错进行，分不出「取素材」和「加工」，所以没有 fetching 这一步。
        await report(CLIP_PROCESSING)
        with TemporaryDirectory(prefix="iclip-reference-") as tmp:
            dest = Path(tmp) / f"out.{_EXT}"
            try:
                await cut_copy_url(source_url, start=start_ms / 1000, end=end_ms / 1000, dest=dest)
                clip_ms = await probe_duration_ms(dest)
            except MediaError as exc:
                raise ProviderError(
                    f"参考片段切不出来: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
                ) from exc
            content = dest.read_bytes()
        await report(CLIP_UPLOADING)
        url = await _store(
            self._object_store, MEDIA_PATHS.video_clip(job_id=job_id, ext=_EXT), content
        )
        return ReferenceCut(url=url, start_ms=max(0, end_ms - clip_ms), end_ms=end_ms)


class FfmpegClipProvider:
    """按 ``VideoComposeRequest`` 合成成片。同步出结果，``submit`` 直接带回 output_url。"""

    def __init__(
        self,
        *,
        object_store: PublicObjectStore,
        report_stage: ReportClipStage,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """``transport`` 给下载素材用，测试替身从这里进；``report_stage`` 由装配注入，provider
        自己不碰数据库。"""

        self._object_store = object_store
        self._report_stage = report_stage
        self._transport = transport

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = request_of(job, VideoComposeRequest, provider=PROVIDER_NAME)
        report = _stage_reporter(self._report_stage, job.id)
        content, duration_ms = await self._render_composite(request, report)
        await report(CLIP_UPLOADING)
        url = await _store(
            self._object_store, MEDIA_PATHS.video_master(job_id=job.id, ext=_EXT), content
        )
        return ProviderSubmission(
            provider_task_id=str(job.id),
            provider_status="completed",
            raw={"durationMs": duration_ms},
            output_url=url,
        )

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        raise ProviderError(
            "本地视频加工是同步的，没有轮询阶段",
            code="PROVIDER_POLL_UNSUPPORTED",
            retryable=False,
        )

    async def _render_composite(
        self, request: VideoComposeRequest, report: _Report
    ) -> tuple[bytes, int]:
        """取齐各段素材，按顺序裁出来拼成一条，一次重编码对齐到原片；返回字节与实际时长（毫秒）。

        取到结尾的段按下载下来的素材时长补齐，补出来是空的段（编辑区间一直改到基底结尾）跳过。
        时长在这里量：产物是我们造的，这里就是权威。临时目录在退出时清掉。"""

        with TemporaryDirectory(prefix="iclip-clip-") as tmp:
            root = Path(tmp)
            dest = root / f"out.{_EXT}"
            await report(CLIP_FETCHING)
            sources = await self._fetch_sources(request.segments, root)
            try:
                cuts = await _cuts(request.segments, sources)
                # 探规格也算取素材：它读的是刚下来的那几条源，还没开始编码。
                profile = await _target_profile(cuts)
                await report(CLIP_PROCESSING)
                await cut_concat(cuts, profile=profile, dest=dest)
                duration_ms = await probe_duration_ms(dest)
            except MediaError as exc:
                raise ProviderError(
                    f"视频加工失败: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
                ) from exc
            return dest.read_bytes(), duration_ms

    async def _fetch_sources(
        self, segments: Sequence[ComposeSegment], root: Path
    ) -> dict[str, Path]:
        """同一个地址只下一遍：合成里基底的前后两段来自同一条视频。"""

        sources: dict[str, Path] = {}
        async with httpx.AsyncClient(transport=self._transport) as client:
            for segment in segments:
                if segment.url in sources:
                    continue
                target = root / f"src-{uuid.uuid4().hex}.{_EXT}"
                try:
                    await download(client, segment.url, target, max_bytes=MAX_VIDEO_BYTES)
                except MediaError as exc:
                    raise ProviderError(
                        f"取不到要加工的素材: {exc}",
                        code="MEDIA_SOURCE_UNREACHABLE",
                        retryable=False,
                    ) from exc
                sources[segment.url] = target
        return sources


async def _cuts(segments: Sequence[ComposeSegment], sources: Mapping[str, Path]) -> list[MediaCut]:
    """各段落成本地素材上的一刀：取到结尾的按素材时长补齐，补出来不成区间的跳过。"""

    lengths: dict[Path, float] = {}
    cuts: list[MediaCut] = []
    for segment in segments:
        source = sources[segment.url]
        end = segment.end
        if end is None:
            if source not in lengths:
                lengths[source] = await probe_duration_ms(source) / 1000
            end = lengths[source]
        if end > segment.start:
            cuts.append(MediaCut(source=source, start=segment.start, end=end))
    if not cuts:
        raise MediaError("各段都是空的，没有要拼的片段")
    return cuts


async def _target_profile(cuts: Sequence[MediaCut]) -> VideoProfile:
    """成片对齐到原片：画幅与帧率照整条最长的那条素材，有一条带音轨就出音轨。

    模型还回来的片段与原片同比例，但分辨率档位与帧率不保证相同（实测 720×960 25fps 的输入
    还回来是 834×1112 24fps）。成片该保持原片的规格，插进去的片段缩放去适配它。哪条是原片
    按素材整条时长认：原片是完整的一条，模型还回来的只有被编辑那一段的长度，所以不管编辑
    区间选了多长，原片都更长——按各段在成片里贡献的时长认不行，区间超过一半就会认反。
    整条一样长（整片都被编辑）再看贡献时长。这样不用调用方多传一个字段。"""

    contributed: dict[Path, float] = {}
    for cut in cuts:
        contributed[cut.source] = contributed.get(cut.source, 0.0) + cut.duration
    lengths = {source: await probe_duration_ms(source) for source in contributed}
    profiles = {source: await probe_video(source) for source in contributed}
    original = profiles[max(contributed, key=lambda source: (lengths[source], contributed[source]))]
    return VideoProfile(
        width=original.width,
        height=original.height,
        frame_rate=original.frame_rate,
        has_audio=any(profile.has_audio for profile in profiles.values()),
    )


__all__ = [
    "PROVIDER_NAME",
    "FfmpegClipProvider",
    "ReferenceCut",
    "ReferenceCutter",
    "ReportClipStage",
]
