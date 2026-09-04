"""出图这一段：提交与渠道升级、把整图切成格落公开地址、拼出版记录与返回。版记录由调用方落盘。"""

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
"""整图按最高档出。切成 4 格后每格只剩四分之一线性分辨率，低档不够交付。"""

ANCHOR_ASPECT: Final = "1:1"
"""补拍整版的画幅。方版分四格后每格也接近方形，站得下全身像也放得下空景。

补拍出来的是参考图，不是要交付的画面，所以不跟目标画幅走——按 9:16 出一版再切，
每格会窄到只剩一条。切格后也不再按画幅收缩：那一刀裁掉的是实体本身。
"""

_JPEG: Final = "image/jpeg"

_STATUS_DONE: Final = "done"
_STATUS_FAILED: Final = "failed"

_EVEN_SPLIT_NOTICE: Final = (
    " 整图没找到清晰的网格线，按等分切的——单格可能带白边或错半格，用之前先看一眼。"
)


@dataclass(frozen=True, slots=True)
class GenerationPolicy:
    """出图的重试与升级节奏：先 dev 试满 ``dev_attempts`` 次，再升 pro 试 ``pro_attempts`` 次；
    任何失败都往下走。

    **升级只在失败时发生。** 「出了图但不够好」是一次新需求，不该在这里悄悄换个
    更贵的渠道重来。
    """

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
    """一批格子切完落地后的成品：给模型的返回、要落盘的版记录、给人看的缩略图墙。"""

    payload: dict[str, Any]
    record: dict[str, Any]
    record_path: str
    urls: Sequence[str]
    captions: Sequence[str]


class FrameGenerator:
    """出图与切格。工作区不归它写：版记录随 ``GridCut`` 交回去。"""

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
        """提交出图，失败就沿 dev→dev→pro 往下试，返回成功那次或最后那次的结局。"""

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
                # 参数不合规是在提交之前拒的，一分钱没花，所以让模型改了重来。
                raise ModelRetry(str(exc)) from exc
            if job.status == "completed" and job.output_url:
                return job
            # 时限用尽就不再提交下一个——提交了也等不到结果。
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
        """镜头帧那一批：切格后按画幅收缩，逐帧记 no/shot/prompt/url。"""

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
        )

    async def collect_anchors(
        self, job: ImageJob, *, descriptions: Sequence[str]
    ) -> GridCut | dict[str, Any]:
        """设定图那一批：切格后不收画幅（那一刀裁掉的会是实体本身），逐格记 index/description/url。"""

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
            # 标题取那一格的描述：``images`` 里只有序号和地址，描述在入参上。
            captions=list(descriptions),
        )

    async def _slice_and_store(
        self, job: ImageJob, *, aspect: str | None, object_keys: Sequence[str], items_key: str
    ) -> tuple[str, list[str], bool] | dict[str, Any]:
        """取整图、切格、逐格落公开地址。

        给出（整图地址、逐格地址、两个轴都量到了真实网格线）；哪一步没成就直接给出该返回给
        模型的那份失败结果。补位的中性面板格不在 ``object_keys`` 里，在此丢弃。
        """

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
        """提交一次生成并等它落到终态。"""

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
        """把切出来的格并行落公开地址，按原顺序返回地址。

        等全部收尾再报第一个失败：默认的 gather 在第一个失败时就抛，其余还在跑的上传
        就成了没人认领的任务，它们随后的失败只会在日志里留一句「异常从未被取回」。
        """

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
        """取回整图按网格线切开；``aspect`` 给定时每格再居中收到该画幅。

        第二个返回值是「两个轴都量到了真实网格线」。退回等分时切出来的格子外观正
        常，不标出来就没人知道它是猜的。
        """

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
    """生成没收敛时的返回值：连渠道与记录号一起给出去。"""

    return _failed_payload(
        f"{job.error_code or '未知'} {job.error_message or ''}".rstrip()
        + f"（{job.channel} 渠道，记录 {job.job_id}）",
        items_key=items_key,
    )


def _failed_payload(error: str, *, items_key: str = "frames") -> dict[str, Any]:
    """生成未收敛时的返回值。``items_key`` 是这件工具本来该给出的那批东西。"""

    return {
        "message": f"生成失败：{error}",
        "status": _STATUS_FAILED,
        items_key: [],
        "error": error,
    }


def _unstored_payload(
    exc: ObjectWriteFailed, job: ImageJob, *, items_key: str = "frames"
) -> dict[str, Any]:
    """图出了、切出来的格却没存进对象存储时的返回值。

    不说成「生成失败」：那次生成已经收敛并计费了，只是产物没落地。
    """

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
