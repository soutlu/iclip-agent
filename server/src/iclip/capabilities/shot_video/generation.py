"""镜头图生成、渠道重试与网格裁剪转存。版记录返回调用方持久化。"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Any, Final

import httpx
from pydantic_ai import ModelRetry

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
    ShotVideoPaths,
)
from iclip.capabilities.shot_video.prompt import GRID_CELLS, GRID_COLS, GRID_ROWS
from iclip.capabilities.shot_video.shots import parse_cell_id
from iclip.domains.identity.public import Principal

GRID_RECORDS_DIR: Final = "frames/grids"
GRID_RECORD_VERSION: Final = 1
ANCHOR_RECORDS_DIR: Final = "anchors"
ANCHOR_RECORD_VERSION: Final = 1

GRID_RESOLUTION: Final = "4k"
"""使用最高分辨率，保证整图裁成多格后仍有足够细节。"""

ANCHOR_ASPECT: Final = "1:1"
"""设定图使用方形网格；裁切后不再收缩到目标画幅，避免裁掉主体。"""

_JPEG: Final = "image/jpeg"

_STATUS_DONE: Final = "done"
_STATUS_FAILED: Final = "failed"

_EVEN_SPLIT_NOTICE: Final = (
    " 整图没找到清晰的网格线，按等分切的——单格可能带白边或错半格，用之前先看一眼。"
)


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
class GridCut:
    """切格结果，包含工具响应、待持久化版记录与预览图。"""

    payload: dict[str, Any]
    record: dict[str, Any]
    record_path: str
    urls: Sequence[str]
    captions: Sequence[str]

    grid_url: str
    """整图地址也会经版记录进入模型上下文，须登记到素材台账。"""


class FrameGenerator:
    """生成与裁剪服务，工作区记录由调用方持久化。"""

    def __init__(
        self,
        *,
        generations: ImageGenerations,
        objects: PublicObjectWriter,
        paths: ShotVideoPaths,
        client: httpx.AsyncClient,
        policy: GenerationPolicy,
    ) -> None:
        self._generations = generations
        self._objects = objects
        self._paths = paths
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

    async def collect_frames(
        self,
        job: ImageJob,
        *,
        cell_ids: Sequence[str],
        prompts: Sequence[str],
        references: Sequence[str],
        global_reference: str,
        target_aspect: str,
    ) -> GridCut | dict[str, Any]:
        """按目标画幅裁剪镜头帧，并生成逐帧记录。"""

        stored = await self._slice_and_store(
            job,
            aspect=target_aspect,
            object_keys=[
                self._paths.shot_cell(job_id=job.job_id, cell_id=cell_id) for cell_id in cell_ids
            ],
            items_key="frames",
        )
        if isinstance(stored, dict):
            return stored
        grid_url, urls, detected = stored

        frames_payload = [
            {"no": cell_id, "shot": parse_cell_id(cell_id)[0], "url": url}
            for cell_id, url in zip(cell_ids, urls, strict=True)
        ]
        record_path = f"{GRID_RECORDS_DIR}/{job.job_id}.json"
        message = (
            f"生成完成 {len(frames_payload)} 帧（{job.channel} 渠道），版记录见 {record_path}。"
        )
        if not detected:
            message += _EVEN_SPLIT_NOTICE
        return GridCut(
            payload={
                "message": message,
                "status": _STATUS_DONE,
                "frames": frames_payload,
                "record": record_path,
                "error": None,
            },
            record={
                "gridRecordVersion": GRID_RECORD_VERSION,
                "jobId": str(job.job_id),
                "gridUrl": grid_url,
                "targetAspect": target_aspect,
                "globalReference": global_reference,
                "referenceImages": list(references),
                "frames": [
                    {**frame, "prompt": prompt}
                    for frame, prompt in zip(frames_payload, prompts, strict=True)
                ],
                "createdAt": int(time.time()),
            },
            record_path=record_path,
            urls=urls,
            captions=list(cell_ids),
            grid_url=grid_url,
        )

    async def collect_anchors(
        self, job: ImageJob, *, descriptions: Sequence[str]
    ) -> GridCut | dict[str, Any]:
        """裁剪设定图并生成逐格记录，保留完整主体而不收缩到目标画幅。"""

        stored = await self._slice_and_store(
            job,
            aspect=None,
            object_keys=[
                self._paths.anchor_sheet(job_id=job.job_id, index=index)
                for index in range(1, len(descriptions) + 1)
            ],
            items_key="images",
        )
        if isinstance(stored, dict):
            return stored
        grid_url, urls, detected = stored

        images = [{"index": index, "url": url} for index, url in enumerate(urls, start=1)]
        record_path = f"{ANCHOR_RECORDS_DIR}/{job.job_id}.json"
        message = f"补拍完成 {len(images)} 格（{job.channel} 渠道），版记录见 {record_path}。"
        if not detected:
            message += _EVEN_SPLIT_NOTICE
        return GridCut(
            payload={
                "message": message,
                "status": _STATUS_DONE,
                "images": images,
                "record": record_path,
                "error": None,
            },
            record={
                "anchorRecordVersion": ANCHOR_RECORD_VERSION,
                "jobId": str(job.job_id),
                "gridUrl": grid_url,
                "sheetAspect": ANCHOR_ASPECT,
                "cells": [
                    {**image, "description": description}
                    for image, description in zip(images, descriptions, strict=True)
                ],
                "createdAt": int(time.time()),
            },
            record_path=record_path,
            urls=urls,
            captions=list(descriptions),
            grid_url=grid_url,
        )

    async def _slice_and_store(
        self, job: ImageJob, *, aspect: str | None, object_keys: Sequence[str], items_key: str
    ) -> tuple[str, list[str], bool] | dict[str, Any]:
        """下载、裁剪并转存网格，返回整图地址、逐格地址与网格检测标志。

        失败时返回工具错误结果；补位格不在 object_keys 中，不转存。"""

        grid_url = job.output_url
        if not grid_url:
            return _failed_payload("生成记录未携带结果 URL", items_key=items_key)
        try:
            cells, detected = await self._slice_grid(grid_url, aspect=aspect)
        except (ffmpeg.MediaError, GridError) as exc:
            return _failed_payload(str(exc), items_key=items_key)
        if len(cells) != GRID_CELLS:
            return _failed_payload("整图切格数量异常", items_key=items_key)

        try:
            urls = await self._put_all(list(zip(object_keys, cells, strict=False)))
        except ObjectWriteFailed as exc:
            return _unstored_payload(exc, job, items_key=items_key)
        return grid_url, urls, detected

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

    async def _slice_grid(self, grid_url: str, *, aspect: str | None) -> tuple[list[bytes], bool]:
        """检测网格并裁剪，指定 aspect 时居中收缩。返回检测标志，明确区分实测边界与等分结果。"""

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
            return await ffmpeg.crop_cells(source, boxes), layout.detected


def job_failure(job: ImageJob, *, items_key: str = "frames") -> dict[str, Any]:
    """生成失败或未结束时的响应，包含渠道与任务 id。"""

    return _failed_payload(
        f"{job.error_code or '未知'} {job.error_message or ''}".rstrip()
        + f"（{job.channel} 渠道，记录 {job.job_id}）",
        items_key=items_key,
    )


def _failed_payload(error: str, *, items_key: str = "frames") -> dict[str, Any]:
    """生成未成功时的工具响应，items_key 指定该工具的产物字段。"""

    return {
        "message": f"生成失败：{error}",
        "status": _STATUS_FAILED,
        items_key: [],
        "error": error,
    }


def _unstored_payload(
    exc: ObjectWriteFailed, job: ImageJob, *, items_key: str = "frames"
) -> dict[str, Any]:
    """生成成功但切格转存失败的响应；保留已完成生成的事实。"""

    error = f"切出来的图没存进对象存储：{exc}（{job.channel} 渠道，记录 {job.job_id}）"
    return {
        "message": f"生成已完成，但{error}。重新调用一次。",
        "status": _STATUS_FAILED,
        items_key: [],
        "error": error,
    }


__all__ = [
    "ANCHOR_ASPECT",
    "ANCHOR_RECORDS_DIR",
    "ANCHOR_RECORD_VERSION",
    "GRID_RECORDS_DIR",
    "GRID_RECORD_VERSION",
    "GRID_RESOLUTION",
    "FrameGenerator",
    "GenerationPolicy",
    "GridCut",
    "job_failure",
]
