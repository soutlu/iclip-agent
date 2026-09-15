"""本地视频加工适配器：按 segment 列表裁剪拼接，产物存进本系统的桶。

不经任何外部服务，一次调用出结果，没有轮询阶段，也不涉及计费——失败重发就是了。
参考片段与成片走同一套操作，差别只在重不重编码、存哪个前缀。"""

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
    cut_copy,
    download,
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
        """取素材、裁剪拼接，返回成品字节。临时目录在退出时清掉。"""

        with TemporaryDirectory(prefix="iclip-clip-") as tmp:
            root = Path(tmp)
            sources = await self._fetch_sources(request.segments, root)
            cuts = [
                MediaCut(source=sources[segment.url], start=segment.start, end=segment.end)
                for segment in request.segments
            ]
            dest = root / f"out.{_EXT}"
            try:
                if request.purpose == CLIP_REFERENCE:
                    await cut_copy(cuts[0], dest=dest)
                else:
                    await cut_concat(cuts, profile=await _target_profile(cuts), dest=dest)
            except MediaError as exc:
                raise ProviderError(
                    f"视频加工失败: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
                ) from exc
            return dest.read_bytes()

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
    """拼接的目标参数取画幅最大的那条素材，有一条带音轨就出音轨。

    不取「第一段」或「上一版」：模型还回来的片段画幅未必与原片一致，跟着它走会让成片一版
    比一版小。取最大的，任何一段都不会被放大。"""

    profiles = [await probe_video(source) for source in {cut.source for cut in cuts}]
    largest = max(profiles, key=lambda item: item.width * item.height)
    return VideoProfile(
        width=largest.width,
        height=largest.height,
        frame_rate=largest.frame_rate,
        has_audio=any(profile.has_audio for profile in profiles),
    )


__all__ = ["PROVIDER_NAME", "FfmpegClipProvider"]
