"""镜头图生成、渠道重试与网格裁剪转存。版记录与工具返回值由调用方拼装。"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Final, NoReturn

import httpx
import structlog
from pydantic_ai import ModelRetry, ToolFailed

from iclip.capabilities.shot_video import ffmpeg
from iclip.capabilities.shot_video.grid import (
    GridError,
    fit_box_to_aspect,
    grid_cell_boxes,
    parse_aspect,
    scale_box,
)
from iclip.capabilities.shot_video.ports import (
    ImageChannel,
    ImageGenerations,
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
    ObjectWriteFailed,
    PublicObjectWriter,
)
from iclip.capabilities.shot_video.prompt import GRID_CELLS, GRID_COLS, GRID_ROWS
from iclip.domains.identity.public import Principal

_logger = structlog.stdlib.get_logger(__name__)

IMAGE_MODEL: Final = "nano_banana_pro"
"""出图用哪家。写在这里而不是配置里：这条链路的 4k 整图与 dev/pro 重试只有这一家给得了，
产品接口的默认模型换成别家不该带着它一起换。"""

GRID_RESOLUTION: Final = "4k"
"""使用最高分辨率，保证整图裁成多格后仍有足够细节。"""

ANCHOR_ASPECT: Final = "1:1"
"""设定图使用方形网格；裁切后不再收缩到目标画幅，避免裁掉主体。"""

_JPEG: Final = "image/jpeg"


@dataclass(frozen=True, slots=True)
class GenerationPolicy:
    """按配置的 dev、pro 顺序重试失败生成；已有成功结果时不自动升级渠道。"""

    poll_interval_seconds: float = 5.0
    dev_attempts: int = 2
    pro_attempts: int = 1
    backoff_seconds: float = 5.0
    backoff_factor: float = 3.0
    total_timeout_seconds: float = 1800.0

    def channels(self) -> tuple[ImageChannel, ...]:
        dev: tuple[ImageChannel, ...] = ("dev",) * self.dev_attempts
        pro: tuple[ImageChannel, ...] = ("pro",) * self.pro_attempts
        return (*dev, *pro)


@dataclass(frozen=True, slots=True)
class CellCut:
    """一次切格转存的结果：未切的整图，与逐格转存后的地址。"""

    grid_url: str
    urls: tuple[str, ...]


class FrameGenerator:
    """生成与裁剪服务，工作区记录由调用方持久化。"""

    def __init__(
        self,
        *,
        generations: ImageGenerations,
        objects: PublicObjectWriter,
        client: httpx.AsyncClient,
        policy: GenerationPolicy,
    ) -> None:
        self._generations = generations
        self._objects = objects
        self._client = client
        self._policy = policy

    async def generate(self, principal: Principal, request: ImageRequest) -> ImageJob:
        """按配置渠道顺序重试，返回成功结果或最后一次结果。"""

        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._policy.total_timeout_seconds
        channels = self._policy.channels()
        job: ImageJob | None = None
        for index, channel in enumerate(channels):
            try:
                job = await self._run_one(
                    principal, replace(request, channel=channel), deadline=deadline
                )
            except InvalidImageRequest as exc:
                # 提交前校验失败，不产生付费调用，可要求模型修正参数。
                raise ModelRetry(str(exc)) from exc
            if job.status == "completed" and job.output_url:
                return job
            if index == len(channels) - 1 or loop.time() >= deadline:
                return job
            await asyncio.sleep(self._policy.backoff_seconds * self._policy.backoff_factor**index)
        raise AssertionError("重试策略至少要有一个渠道")

    async def cut(
        self, job: ImageJob, *, object_keys: Sequence[str], aspect: str | None, failure_message: str
    ) -> CellCut:
        """下载整图、裁剪并转存，逐格地址与 ``object_keys`` 同序。

        整图恒为 GRID_CELLS 格，``object_keys`` 只给实际请求的那几格，多出来的是补位格，
        不转存。失败时向模型报告简短错误，诊断信息留日志。"""

        grid_url = job.output_url
        if not grid_url:
            job_failure(job, message=failure_message, reason="生成记录未携带结果 URL")
        try:
            cells = await self._slice_grid(grid_url, aspect=aspect)
        except (ffmpeg.MediaError, GridError) as exc:
            job_failure(job, message=failure_message, reason=str(exc))
        if len(cells) != GRID_CELLS:
            job_failure(job, message=failure_message, reason="整图切格数量异常")

        try:
            urls = await self._put_all(
                list(zip(object_keys, cells[: len(object_keys)], strict=True))
            )
        except ObjectWriteFailed as exc:
            job_failure(job, message=failure_message, reason=str(exc))
        return CellCut(grid_url=grid_url, urls=tuple(urls))

    async def _run_one(
        self, principal: Principal, request: ImageRequest, *, deadline: float
    ) -> ImageJob:

        job = await self._generations.submit(principal, request)
        loop = asyncio.get_running_loop()
        while not job.finished:
            if loop.time() >= deadline:
                return ImageJob(
                    job_id=job.job_id,
                    status="failed",
                    channel=request.channel,
                    error_code="TOOL_WAIT_TIMEOUT",
                    error_message="等这次生成等超时了；它可能还在后台跑",
                )
            await asyncio.sleep(self._policy.poll_interval_seconds)
            job = await self._generations.get(principal, job.job_id)
        return job

    async def _put_all(self, cells: Sequence[tuple[str, bytes]]) -> list[str]:
        """并行上传格子并保持返回顺序；等待全部任务结束后报告首个失败，避免遗留未收集异常。"""

        results = await asyncio.gather(
            *(
                self._objects.put_public_object(
                    object_key=object_key, content=content, content_type=_JPEG
                )
                for object_key, content in cells
            ),
            return_exceptions=True,
        )
        urls: list[str] = []
        for result in results:
            if isinstance(result, BaseException):
                raise result
            urls.append(result)
        return urls

    async def _slice_grid(self, grid_url: str, *, aspect: str | None) -> list[bytes]:
        """检测网格并裁剪，指定 aspect 时居中收缩；检测不到分隔带的轴由 grid 按等分退回。"""

        async with ffmpeg.fetched(
            self._client, grid_url, max_bytes=ffmpeg.MAX_IMAGE_BYTES, suffix=".img"
        ) as source:
            gray, full_width = await ffmpeg.decode_gray(source)
            layout = grid_cell_boxes(gray, rows=GRID_ROWS, cols=GRID_COLS)
            boxes = [
                scale_box(box, from_width=gray.width, to_width=full_width) for box in layout.boxes
            ]
            if aspect is not None:
                ratio = parse_aspect(aspect)
                boxes = [fit_box_to_aspect(box, ratio) for box in boxes]
            return await ffmpeg.crop_cells(source, boxes)


def job_failure(job: ImageJob, *, message: str, reason: str | None = None) -> NoReturn:
    """记录诊断信息并报告失败。模型收到短句加错误码，供它判断重试是否有用；网关原文只留日志。"""

    _logger.warning(
        "图像工具失败",
        job_id=str(job.job_id),
        channel=job.channel,
        error_code=job.error_code,
        reason=reason if reason is not None else job.error_message,
    )
    # 切格、下载、转存阶段的失败没有错误码，调用方给的短句本身已写明阶段。
    if job.error_code is None:
        raise ToolFailed(message)
    raise ToolFailed(f"{message.rstrip('。')}（{job.error_code}）。")


__all__ = [
    "ANCHOR_ASPECT",
    "GRID_RESOLUTION",
    "IMAGE_MODEL",
    "CellCut",
    "FrameGenerator",
    "GenerationPolicy",
    "job_failure",
]
