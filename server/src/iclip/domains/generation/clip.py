"""本地视频加工适配器：按 segment 列表裁剪拼接，产物存进本系统的桶。

不经任何外部服务，一次调用出结果，没有轮询阶段，也不涉及计费——失败重发就是了。
参考片段与成片的差别有三处：怎么取素材、重不重编码、存哪个前缀。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final

import httpx

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
)
from iclip.domains.generation.schemas import CLIP_REFERENCE, ClipIn, ClipSegmentIn
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

PROVIDER_NAME: Final = "ffmpeg"

_EXT: Final = "mp4"
_CONTENT_TYPE: Final = "video/mp4"


class FfmpegClipProvider:
    """按 ``ClipIn`` 裁剪拼接视频。同步出结果，``submit`` 直接带回 output_url。"""

    def __init__(
        self,
        *,
        object_store: PublicObjectStore,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """``transport`` 只作用于成片那条路径。

        参考片段由 ffmpeg 自己发 http 请求按需读，替身拦不到它——测试得起一个真服务。"""

        self._object_store = object_store
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
        content = await self._render(request)
        key = (
            MEDIA_PATHS.video_clip(job_id=job.id, ext=_EXT)
            if request.purpose == CLIP_REFERENCE
            else MEDIA_PATHS.video_master(job_id=job.id, ext=_EXT)
        )
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
            raw={"purpose": request.purpose, "segments": len(request.segments)},
            output_url=url,
        )

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        raise ProviderError(
            "本地视频加工是同步的，没有轮询阶段",
            code="PROVIDER_POLL_UNSUPPORTED",
            retryable=False,
        )

    async def _render(self, request: ClipIn) -> bytes:
        """加工出成品并返回字节。临时目录在退出时清掉。

        两种用途取素材的方式不同：参考片段只要一条视频里的一段，交给 ffmpeg 按需远程读；
        成片要把好几段拼起来，滤镜图会在编码期来回读各路输入，仍然先下到本地。"""

        with TemporaryDirectory(prefix="iclip-clip-") as tmp:
            root = Path(tmp)
            dest = root / f"out.{_EXT}"
            try:
                if request.purpose == CLIP_REFERENCE:
                    await self._render_reference(request, dest=dest)
                else:
                    await self._render_master(request, root=root, dest=dest)
            except MediaError as exc:
                raise ProviderError(
                    f"视频加工失败: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
                ) from exc
            return dest.read_bytes()

    async def _render_reference(self, request: ClipIn, *, dest: Path) -> None:
        """按需读远程视频，裁出唯一那一段。

        读取与裁剪交错进行，分不出「取素材」和「加工」，所以取不到素材（签名过期、404）
        也归 MEDIA_PROCESS_FAILED，原因写在错误消息里。"""

        segment = request.segments[0]
        await cut_copy_url(segment.url, start=segment.start, end=segment.end, dest=dest)

    async def _render_master(self, request: ClipIn, *, root: Path, dest: Path) -> None:
        """取齐各段素材，按顺序裁出来拼成一条，一次重编码对齐到原片。"""

        sources = await self._fetch_sources(request.segments, root)
        cuts = [
            MediaCut(source=sources[segment.url], start=segment.start, end=segment.end)
            for segment in request.segments
        ]
        await cut_concat(cuts, profile=await _target_profile(cuts), dest=dest)

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


__all__ = ["PROVIDER_NAME", "FfmpegClipProvider"]
