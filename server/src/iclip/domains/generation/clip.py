"""本地视频加工适配器：按 segment 列表裁剪拼接，产物存进本系统的桶。

不经任何外部服务，一次调用出结果，没有轮询阶段，也不涉及计费——失败重发就是了。
参考片段与成片的差别有三处：怎么取素材、重不重编码、存哪个前缀。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Sequence
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
)
from iclip.domains.generation.schemas import (
    CLIP_FETCHING,
    CLIP_PROCESSING,
    CLIP_REFERENCE,
    CLIP_UPLOADING,
    ClipIn,
    ClipSegmentIn,
    ClipStage,
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
    probe_video,
)
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.oss import ObjectStoreUnavailable, PublicObjectStore

_logger = structlog.stdlib.get_logger(__name__)

PROVIDER_NAME: Final = "ffmpeg"

_EXT: Final = "mp4"
_CONTENT_TYPE: Final = "video/mp4"

ReportClipStage = Callable[[uuid.UUID, ClipStage], Awaitable[bool]]
"""上报一次阶段。返回 False 表示这条任务已经不在提交中，调用方不必再报。"""

_Report = Callable[[ClipStage], Awaitable[None]]
"""只服务一次 ``submit`` 调用的上报器，由 ``_reporter`` 造。"""


class FfmpegClipProvider:
    """按 ``ClipIn`` 裁剪拼接视频。同步出结果，``submit`` 直接带回 output_url。"""

    def __init__(
        self,
        *,
        object_store: PublicObjectStore,
        report_stage: ReportClipStage,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """``transport`` 只作用于成片那条路径。

        参考片段由 ffmpeg 自己发 http 请求按需读，替身拦不到它——测试得起一个真服务。
        ``report_stage`` 由装配注入，provider 自己不碰数据库。"""

        self._object_store = object_store
        self._report_stage = report_stage
        self._transport = transport

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = job.request
        if not isinstance(request, ClipIn):
            raise ProviderError(
                f"{PROVIDER_NAME} 只处理本地视频加工请求",
                code="REQUEST_KIND_MISMATCH",
                retryable=False,
            )
        report = self._reporter(job.id)
        content, duration_ms = await self._render(request, report)
        key = (
            MEDIA_PATHS.video_clip(job_id=job.id, ext=_EXT)
            if request.purpose == CLIP_REFERENCE
            else MEDIA_PATHS.video_master(job_id=job.id, ext=_EXT)
        )
        await report(CLIP_UPLOADING)
        try:
            url = await self._object_store.put_public_object(
                object_key=key, content=content, content_type=_CONTENT_TYPE
            )
        except ObjectStoreUnavailable as exc:
            raise ProviderError(
                f"视频加工完了但存不进桶: {exc}",
                code="OUTPUT_STORE_FAILED",
                retryable=False,
            ) from exc
        return ProviderSubmission(
            provider_task_id=str(job.id),
            provider_status="completed",
            raw={"purpose": request.purpose, "durationMs": duration_ms},
            output_url=url,
        )

    def _reporter(self, job_id: uuid.UUID) -> _Report:
        """造一个只服务这一次调用的上报器。

        实例被多个任务共享，所以「还在途」这个标记留在闭包里，不挂在 self 上。上报被拒之后
        就不再报，但活照样干完——产物按任务 id 落在固定的 key 上，迟到的上传覆盖它自己那份。"""

        live = True

        async def report(stage: ClipStage) -> None:
            nonlocal live
            if not live:
                return
            try:
                live = await self._report_stage(job_id, stage)
            except Exception as exc:
                # 阶段词只是给人看的：写不进去就不写了，不能让它把一条能出结果的加工判成失败。
                live = False
                _logger.warning("阶段上报失败，这次加工不再上报", job_id=job_id, error=str(exc))
                return
            if not live:
                _logger.info("加工任务已有结论，不再上报阶段", job_id=job_id, stage=stage)

        return report

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        raise ProviderError(
            "本地视频加工是同步的，没有轮询阶段",
            code="PROVIDER_POLL_UNSUPPORTED",
            retryable=False,
        )

    async def _render(self, request: ClipIn, report: _Report) -> tuple[bytes, int]:
        """加工出成品，返回字节与实际时长（毫秒）。临时目录在退出时清掉。

        两种用途取素材的方式不同：参考片段只要一条视频里的一段，交给 ffmpeg 按需远程读；
        成片要把好几段拼起来，滤镜图会在编码期来回读各路输入，仍然先下到本地。

        时长在这里探：参考片段按关键帧下刀，产物比请求的区间长，长多少只有量产物才知道，
        而产物是我们造的，这里就是权威——调用方不必再自己想办法量一遍。"""

        with TemporaryDirectory(prefix="iclip-clip-") as tmp:
            root = Path(tmp)
            dest = root / f"out.{_EXT}"
            try:
                if request.purpose == CLIP_REFERENCE:
                    await self._render_reference(request, report, dest=dest)
                else:
                    await self._render_master(request, report, root=root, dest=dest)
                duration_ms = await probe_duration_ms(dest)
            except MediaError as exc:
                raise ProviderError(
                    f"视频加工失败: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
                ) from exc
            return dest.read_bytes(), duration_ms

    async def _render_reference(self, request: ClipIn, report: _Report, *, dest: Path) -> None:
        """按需读远程视频，裁出唯一那一段。

        读取与裁剪交错进行，分不出「取素材」和「加工」——所以没有 fetching 这一步，取不到
        素材（签名过期、404）也归 MEDIA_PROCESS_FAILED，原因写在错误消息里。"""

        segment = request.segments[0]
        await report(CLIP_PROCESSING)
        await cut_copy_url(segment.url, start=segment.start, end=segment.end, dest=dest)

    async def _render_master(
        self, request: ClipIn, report: _Report, *, root: Path, dest: Path
    ) -> None:
        """取齐各段素材，按顺序裁出来拼成一条，一次重编码对齐到原片。"""

        await report(CLIP_FETCHING)
        sources = await self._fetch_sources(request.segments, root)
        cuts = [
            MediaCut(source=sources[segment.url], start=segment.start, end=segment.end)
            for segment in request.segments
        ]
        # 探规格也算取素材：它读的是刚下来的那几条源，还没开始编码。
        profile = await _target_profile(cuts)
        await report(CLIP_PROCESSING)
        await cut_concat(cuts, profile=profile, dest=dest)

    async def _fetch_sources(
        self, segments: Sequence[ClipSegmentIn], root: Path
    ) -> dict[str, Path]:
        """同一个地址只下一遍：成片里基底的前后两段来自同一条视频。"""

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


__all__ = ["PROVIDER_NAME", "FfmpegClipProvider", "ReportClipStage"]
