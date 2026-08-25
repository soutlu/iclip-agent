"""镜头素材能力：拆参考片、等间隔取帧分板、按批出帧、读图。

四件工具靠工作区里的两份文件接力：拆解文档（`video/<名>.md`）与取帧账本
（`frames/extraction.json`）。工作区是从本次运行认领的（`ctx.capabilities`），不
从组合根另接一份——同一个 agent 上挂着的那个工作区，才是模型用 `read_file` /
`edit_file` 看得见、改得动的那个。所以时间码写坏了它自己就能修。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Final

import httpx
from pydantic import BaseModel
from pydantic_ai import ModelRetry, ToolReturn
from pydantic_ai.agent.abstract import AgentInstructions
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import BinaryContent
from pydantic_ai.tools import AgentDepsT, RunContext
from pydantic_ai.toolsets import AgentToolset, FunctionToolset

from iclip.capabilities.shot_video import ffmpeg
from iclip.capabilities.shot_video.board import (
    BoardError,
    board_geometry,
    compose_board,
    image_aspect,
)
from iclip.capabilities.shot_video.grid import (
    GridError,
    fit_box_to_aspect,
    grid_cell_boxes,
    parse_aspect,
    scale_box,
)
from iclip.capabilities.shot_video.parser import VideoUnderstandingError
from iclip.capabilities.shot_video.ports import (
    ImageChannel,
    ImageGenerations,
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
    PublicObjectWriter,
    VideoUnderstanding,
    WorkspaceProvider,
)
from iclip.capabilities.shot_video.prompt import (
    GRID_CELLS,
    GRID_COLS,
    GRID_ROWS,
    assemble_grid_prompt,
)
from iclip.capabilities.shot_video.shots import (
    CELL_ID_SHAPE,
    FRAME_INTERVAL_MS,
    SHOT_TIMECODE_SHAPE,
    ShotParseError,
    ShotSpan,
    extraction_key,
    parse_cell_id,
    parse_shot_rows,
    sample_rows,
)
from iclip.capabilities.workspace.store import QuotaExceeded, WorkspaceStore
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.public import Principal

CAPABILITY_ID: Final = "shot_video"

EXTRACTION_PATH: Final = "frames/extraction.json"
EXTRACTION_VERSION: Final = 1
GRID_RECORDS_DIR: Final = "frames/grids"
GRID_RECORD_VERSION: Final = 1

GRID_RESOLUTION: Final = "4k"
"""整图按最高档出。切成 4 格后每格只剩四分之一线性分辨率，低档不够交付。"""

VIEW_MAX_EDGE: Final = 1024
"""附给模型看的那份图的长边像素。交付用的原图另存，不受这个限制。"""

_JPEG: Final = "image/jpeg"
_OSS_PREFIX: Final = "shot-frames"
"""预览板与镜头帧在公开桶里的根。板按取帧键分目录，帧按生成记录分目录。"""
_DOC_DIR: Final = "video"

_UNSAFE_STEM = re.compile(r"[^A-Za-z0-9_-]+")
_STEM_CHARS: Final = 40

_RESENDABLE: Final = frozenset({"PROVIDER_UNREACHABLE", "PROVIDER_SERVER_ERROR"})
"""哪些失败可以自动再发一次。

**判据只有一条：这次失败有没有可能已经计费。** 连不上、对方 5xx 没产出——这两
种确定没扣钱。其余一律停手报错：``PROVIDER_RESULT_UNKNOWN`` 可能已扣过钱，
``OUTPUT_*`` 是图出了只是没转存成功，重发都等于为同一版付两次。
"""

WORKSPACE_ID: Final = "workspace"
"""工作区能力登记的名字。

写死一个字符串而不是去 import 那边的常量：认得它是谁靠的是协议，不是那个类。
"""

_STATUS_DONE: Final = "done"
_STATUS_FAILED: Final = "failed"


class FrameRequest(BaseModel):
    """一格的生成请求。"""

    no: str
    prompt: str


@dataclass(frozen=True, slots=True)
class GenerationPolicy:
    """出图的重试与升级节奏：先 dev 试满 ``dev_attempts`` 次，再升 pro。

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


@dataclass
class ShotVideo(AbstractCapability[AgentDepsT]):
    """把四件工具挂到 agent 上。"""

    generations: ImageGenerations
    objects: PublicObjectWriter
    understanding: VideoUnderstanding
    client: httpx.AsyncClient
    """取素材用的 HTTP 客户端，由组合根持有（连接池不该每次调用重建）。"""

    policy: GenerationPolicy = field(default_factory=GenerationPolicy)

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
        return ShotVideoToolset(self)

    def get_instructions(self) -> AgentInstructions[AgentDepsT] | None:
        # 不注入指令：这几件工具怎么接力是流程知识，归 skill（architecture.md §5）。
        return None

    @classmethod
    def get_serialization_name(cls) -> str | None:
        # 依赖都是运行期对象（服务、连接池），从 YAML spec 里造不出来。
        return None


class ShotVideoToolset(FunctionToolset[AgentDepsT]):
    """四件工具。"""

    def __init__(self, capability: ShotVideo[AgentDepsT]) -> None:
        super().__init__(id=CAPABILITY_ID)
        self._cap = capability
        self.add_function(self.video_parser_md, name="video_parser_md")
        self.add_function(self.plan_shot_frames, name="plan_shot_frames")
        self.add_function(self.generate_shot_frames, name="generate_shot_frames")
        self.add_function(self.read_media_file, name="ReadMediaFile")

    async def video_parser_md(self, ctx: RunContext[AgentDepsT], video_url: str) -> dict[str, Any]:
        """拆解一段参考视频，把拆解文档写进工作区，返回它的路径。

        - 文档含商业目的、结构分段、出场清单和逐镜拉片表，镜头时间码写成
          ``**[00:03.800-00:05.600]**``。
        - 同一段视频不要重复拆解——每次调用都是一次新的拆解，不复用上次结果。
        - 文档正文不随本工具返回；要看内容用 `read_file` 读返回的路径。

        Args:
            ctx: 框架给的运行上下文。
            video_url: 视频地址，逐字取自对话里给你的那个。
        """

        files, namespace = self._workspace(ctx)
        _require_http(video_url, what="视频地址")
        path = video_doc_path(video_url)
        try:
            content = await self._cap.understanding.parse(video_url)
        except VideoUnderstandingError as exc:
            raise ModelRetry(f"这段视频没拆解成功：{exc}") from exc
        await self._write(files, namespace, path, content)
        return {"message": f"视频解析完毕，拆解结果已保存到 {path}。", "path": path}

    async def plan_shot_frames(self, ctx: RunContext[AgentDepsT], video_url: str) -> dict[str, Any]:
        """从参考视频等间隔抽帧，按结构层级分板返回候选帧预览板。

        - 镜头起止时间戳与结构层级分组取自该视频的拆解文档；每秒取一帧，帧按时间
          戳落进覆盖它的镜头。
        - 一个结构层级一张预览板，每张候选帧左上角标注帧号，形如 S8-3（第 8 个镜
          头的第 3 个候选帧）。
        - 图像内容不随本工具返回；用 `ReadMediaFile` 读 url 看板，需要多板时在同一
          次回复中并行读取。
        - 同一视频与同一份拆解文档重复调用会直接复用既有结果，不重复抽帧。
        - 该视频尚未拆解、拆解文档读不出镜头时间戳、或时间戳超出视频时长时返回
          错误。

        Args:
            ctx: 框架给的运行上下文。
            video_url: 参考视频地址，逐字取自对话里给你的那个。
        """

        files, namespace = self._workspace(ctx)
        _require_http(video_url, what="视频地址")
        doc_path = video_doc_path(video_url)
        rows = await self._shot_rows(files, namespace, doc_path)
        try:
            async with ffmpeg.fetched(
                self._cap.client, video_url, max_bytes=ffmpeg.MAX_VIDEO_BYTES, suffix=".mp4"
            ) as source:
                duration = await ffmpeg.probe_duration_ms(source)
                _check_in_range(rows, duration_ms=duration)
                video_hash = await asyncio.to_thread(_sha256_file, source)
                key = extraction_key(
                    video_hash=video_hash, rows=rows, interval_ms=FRAME_INTERVAL_MS
                )
                document = await self._load_extraction(files, namespace, expected_key=key)
                reused = document is not None
                if document is None:
                    document = await self._build_extraction(
                        source=source,
                        key=key,
                        video_url=video_url,
                        video_hash=video_hash,
                        rows=rows,
                    )
        except (ffmpeg.MediaError, BoardError) as exc:
            raise ModelRetry(str(exc)) from exc
        if not reused:
            await self._write(
                files,
                namespace,
                EXTRACTION_PATH,
                json.dumps(document, ensure_ascii=False, indent=2),
            )

        boards = document["boards"]
        cells_total = sum(len(board["cells"]) for board in boards)
        flat = sum(len(row) for row in rows)
        message = (
            f"取帧{'复用既有账本' if reused else '完成'}：从 {doc_path} 读到 {flat} 个镜头分 "
            f"{len(rows)} 个结构层级，每秒一帧共 {cells_total} 个候选帧，取帧账本见 "
            f"{EXTRACTION_PATH}；每板用 ReadMediaFile 读 url 查看，候选帧上的标注即帧号"
            f"（{CELL_ID_SHAPE}）。"
        )
        starved = document["shotsWithoutCells"]
        if starved:
            message += f" 短于一秒未取到候选帧的镜头：{', '.join(map(str, starved))}。"
        return {
            "message": message,
            "boards": [
                {"board": board["board"], "shots": board["shots"], "url": board["url"]}
                for board in boards
            ],
        }

    async def generate_shot_frames(
        self,
        ctx: RunContext[AgentDepsT],
        frames: list[FrameRequest],
        reference_images: list[str],
        global_reference: str,
        target_aspect: str,
    ) -> dict[str, Any]:
        """按选中的候选帧生成镜头帧：一次调用出一张 2×2 网格图、切成 4 帧返回逐帧 URL。

        - frames 每条给一个候选帧身份（预览板上标注的 S8-3 形状）与为它撰写的
          visual_prompt。
        - 一批 1-4 条；不足 4 条时空格由中性面板补满并在切格后丢弃。
        - reference_images 的顺序即 global_reference 中 @Image1..N 的编号。
        - 需要多次调用时，在同一次回复中并行发起，不要串行等待。
        - 生成需要数分钟，调用会阻塞到收敛后返回。
        - 每次调用都重新提交生成，没有复用；同一批帧不满意就改 prompt 再调。
        - 每批成功后把逐帧 no/shot/prompt/url 与本批入参写进版记录
          ``frames/grids/<jobId>.json``。
        - 该视频尚未抽帧、帧号格式错误、帧号不存在或重复时返回错误。

        Args:
            ctx: 框架给的运行上下文。
            frames: 逐格请求，1-4 条。
            reference_images: 参考图地址，顺序即 @Image1..N；逐字取自工具结果或对话。
            target_aspect: 目标画幅，如 ``9:16``。
            global_reference: 整段「全局参考设定」文本。
        """

        files, namespace = self._workspace(ctx)
        principal = _principal(ctx)
        document = await self._load_extraction(files, namespace, expected_key=None)
        if document is None:
            raise ModelRetry("取帧账本不存在或版本不兼容，先调用 plan_shot_frames。")
        cell_ids, prompts = _resolve_requests(frames, document)
        references = tuple(reference_images)
        for url in references:
            _require_http(url, what="参考图地址")
        try:
            prompt = assemble_grid_prompt(
                global_reference=global_reference,
                visual_prompts=prompts,
                target_aspect=target_aspect,
            )
        except ValueError as exc:
            raise ModelRetry(str(exc)) from exc

        job = await self._generate(
            principal,
            ImageRequest(
                prompt=prompt,
                aspect_ratio=target_aspect,
                resolution=GRID_RESOLUTION,
                channel="dev",
                reference_image_urls=references,
            ),
        )
        if job.status != "completed" or not job.output_url:
            return _failed_payload(
                f"{job.error_code or '未知'} {job.error_message or ''}".rstrip()
                + f"（{job.channel} 渠道，记录 {job.job_id}）"
            )
        return await self._collect(
            files,
            namespace,
            job,
            cell_ids=cell_ids,
            prompts=prompts,
            references=references,
            global_reference=global_reference,
            target_aspect=target_aspect,
        )

    async def read_media_file(self, ctx: RunContext[AgentDepsT], url: str) -> ToolReturn:
        """读取一张图片，原始内容以多模态形式附在工具结果中。

        - 本工具通常是你会希望并行使用的工具：需要看多张图时在同一次回复中发起多
          次调用，不要分多轮逐张读取。
        - 已读取且仍在上下文中的图片不要重复读取。
        - 本工具只读图片。视频信息读拆解文档，文本与产物文件用 `read_file`。

        Args:
            ctx: 框架给的运行上下文。
            url: 图片地址，逐字取自对话或本会话工具结果里的图片 URL，不要自行构造。
        """

        _ = _principal(ctx)
        _require_http(url, what="图片地址")
        try:
            async with ffmpeg.fetched(
                self._cap.client, url, max_bytes=ffmpeg.MAX_IMAGE_BYTES, suffix=".img"
            ) as source:
                data = await asyncio.to_thread(source.read_bytes)
            view = await ffmpeg.shrink(data, max_edge=VIEW_MAX_EDGE)
        except ffmpeg.MediaError as exc:
            raise ModelRetry(str(exc)) from exc
        return ToolReturn(
            return_value=f"已读取图片 {url}，其原始内容已附在本工具结果中。",
            content=[BinaryContent(data=view, media_type=_JPEG)],
        )

    async def _shot_rows(
        self, files: WorkspaceStore, namespace: str, doc_path: str
    ) -> tuple[tuple[ShotSpan, ...], ...]:
        """从拆解文档读逐镜时间区间；读不出就给出一条模型能自己走的修复路径。"""

        stored = await files.read(namespace, doc_path)
        if stored is None:
            raise ModelRetry(
                f"参考视频拆解文档 {doc_path} 不存在，先对该视频调用 video_parser_md。"
            )
        try:
            return parse_shot_rows(stored.content)
        except ShotParseError as exc:
            raise ModelRetry(
                f"参考视频拆解文档 {doc_path} 解析失败：{exc}。用 edit_file 就地把该时间码改成 "
                f"{SHOT_TIMECODE_SHAPE} 形状（只改时间码，不动正文）后重新调用；整份文档都读"
                f"不出时改为对该视频重新调用 video_parser_md。"
            ) from exc

    async def _build_extraction(
        self,
        *,
        source: Path,
        key: str,
        video_url: str,
        video_hash: str,
        rows: Sequence[Sequence[ShotSpan]],
    ) -> dict[str, Any]:
        """整片按秒抽帧、逐结构层级拼板落公开地址，产出取帧账本。"""

        with TemporaryDirectory(prefix="shot-video-frames-") as tmp:
            frames = await ffmpeg.extract_frames(
                source, fps=1000 / FRAME_INTERVAL_MS, out_dir=Path(tmp)
            )
            cell_aspect = await asyncio.to_thread(image_aspect, frames[0])
            sampled = sample_rows(rows, interval_ms=FRAME_INTERVAL_MS)
            boards: list[dict[str, Any]] = []
            for index, (row, cells) in enumerate(zip(rows, sampled, strict=True), start=1):
                in_range = [
                    cell for cell in cells if cell.src_ms // FRAME_INTERVAL_MS < len(frames)
                ]
                if not in_range:
                    continue
                geometry = await asyncio.to_thread(
                    board_geometry, len(in_range), cell_aspect=cell_aspect
                )
                image = await asyncio.to_thread(
                    compose_board,
                    [(cell.cell_id, frames[cell.src_ms // FRAME_INTERVAL_MS]) for cell in in_range],
                    geometry=geometry,
                )
                url = await self._cap.objects.put_public_object(
                    object_key=f"{_OSS_PREFIX}/{key}/board/{index}.jpg",
                    content=image,
                    content_type=_JPEG,
                )
                boards.append(
                    {
                        "board": index,
                        "url": url,
                        "shots": sorted({shot.shot_id for shot in row}),
                        "layout": f"{geometry.cols}x{geometry.rows}",
                        "cells": [
                            {"id": cell.cell_id, "shotId": cell.shot_id} for cell in in_range
                        ],
                    }
                )
        covered = {cell["shotId"] for board in boards for cell in board["cells"]}
        return {
            "extractionVersion": EXTRACTION_VERSION,
            "extractionKey": key,
            "intervalMs": FRAME_INTERVAL_MS,
            "video": {"url": video_url, "contentHash": f"sha256:{video_hash}"},
            "boards": boards,
            "shotsWithoutCells": sorted(
                shot.shot_id for row in rows for shot in row if shot.shot_id not in covered
            ),
        }

    async def _generate(self, principal: Principal, request: ImageRequest) -> ImageJob:
        """提交出图，失败就按 dev→dev→pro 退避重试，返回最后那次的结局。"""

        deadline = asyncio.get_running_loop().time() + self._cap.policy.total_timeout_seconds
        channels = self._cap.policy.channels()
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
            if index == len(channels) - 1 or job.error_code not in _RESENDABLE:
                return job
            await asyncio.sleep(
                self._cap.policy.backoff_seconds * self._cap.policy.backoff_factor**index
            )
        raise AssertionError("重试策略至少要有一个渠道")

    async def _run_one(
        self, principal: Principal, request: ImageRequest, *, deadline: float
    ) -> ImageJob:
        """提交一次生成并等它落到终态。"""

        job = await self._cap.generations.submit(principal, request)
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
            await asyncio.sleep(self._cap.policy.poll_interval_seconds)
            job = await self._cap.generations.get(principal, job.job_id)
        return job

    async def _collect(
        self,
        files: WorkspaceStore,
        namespace: str,
        job: ImageJob,
        *,
        cell_ids: Sequence[str],
        prompts: Sequence[str],
        references: Sequence[str],
        global_reference: str,
        target_aspect: str,
    ) -> dict[str, Any]:
        """取整图、切格、逐帧落公开地址、写版记录。补位的中性面板格在此丢弃。"""

        grid_url = job.output_url
        if not grid_url:
            return _failed_payload("生成记录未携带结果 URL")
        try:
            async with ffmpeg.fetched(
                self._cap.client, grid_url, max_bytes=ffmpeg.MAX_IMAGE_BYTES, suffix=".img"
            ) as source:
                gray, full_width = await ffmpeg.decode_gray(source)
                layout = grid_cell_boxes(gray, rows=GRID_ROWS, cols=GRID_COLS)
                ratio = parse_aspect(target_aspect)
                boxes = [
                    fit_box_to_aspect(
                        scale_box(box, from_width=gray.width, to_width=full_width), ratio
                    )
                    for box in layout.boxes
                ]
                cells = await ffmpeg.crop_cells(source, boxes)
        except (ffmpeg.MediaError, GridError) as exc:
            return _failed_payload(str(exc))
        if len(cells) != GRID_CELLS:
            return _failed_payload("整图切格数量异常")

        urls = await asyncio.gather(
            *(
                self._cap.objects.put_public_object(
                    object_key=f"{_OSS_PREFIX}/{job.job_id}/out/{cell_id}.jpg",
                    content=cell,
                    content_type=_JPEG,
                )
                for cell_id, cell in zip(cell_ids, cells, strict=False)
            )
        )
        frames_payload = [
            {"no": cell_id, "shot": parse_cell_id(cell_id)[0], "url": url}
            for cell_id, url in zip(cell_ids, urls, strict=True)
        ]
        record_path = f"{GRID_RECORDS_DIR}/{job.job_id}.json"
        record = {
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
        }
        await self._write(
            files, namespace, record_path, json.dumps(record, ensure_ascii=False, indent=2)
        )
        message = (
            f"生成完成 {len(frames_payload)} 帧（{job.channel} 渠道），版记录见 {record_path}。"
        )
        if not layout.detected:
            message += (
                " 整图没找到清晰的网格线，按等分切的——单格可能带白边或错半格，用之前先看一眼。"
            )
        return {
            "message": message,
            "status": _STATUS_DONE,
            "frames": frames_payload,
            "record": record_path,
            "error": None,
        }

    async def _load_extraction(
        self, files: WorkspaceStore, namespace: str, *, expected_key: str | None
    ) -> dict[str, Any] | None:
        """读取帧账本；版本不符或（给定时）key 不匹配一律视为不存在。"""

        stored = await files.read(namespace, EXTRACTION_PATH)
        if stored is None:
            return None
        try:
            document = json.loads(stored.content)
        except json.JSONDecodeError:
            return None
        if not isinstance(document, dict):
            return None
        if document.get("extractionVersion") != EXTRACTION_VERSION:
            return None
        if expected_key is not None and document.get("extractionKey") != expected_key:
            return None
        return document

    async def _write(self, files: WorkspaceStore, namespace: str, path: str, content: str) -> None:
        try:
            await files.write(namespace, path, content)
        except QuotaExceeded as exc:
            raise ModelRetry(f"工作区写不下 {path}：{exc} 用 delete_file 清掉不用的文件。") from exc

    def _workspace(self, ctx: RunContext[AgentDepsT]) -> tuple[WorkspaceStore, str]:
        """认领这次运行里挂着的工作区。

        不从组合根接一份自己的：这几件工具写的文档和账本，模型要用 `read_file` /
        `edit_file` 去看去改。两边各拿各的存储，迟早落到不同的地方去。
        """

        found = ctx.capabilities.get(WORKSPACE_ID)
        if not isinstance(found, WorkspaceProvider):
            raise RuntimeError(
                f"这个 agent 没挂 {WORKSPACE_ID} 能力，"
                "而拆解文档与取帧账本都写在工作区里——在 agents.yaml 里给它补上。"
            )
        return found.store, found.resolve_scope(ctx)


def video_doc_path(video_url: str) -> str:
    """拆解文档在工作区里的路径。

    纯由 URL 算出，所以拆片和取帧两件工具各算各的也落在同一份文件上。带哈希后缀是
    因为两段不同的视频完全可能同名。
    """

    stem = _UNSAFE_STEM.sub("-", video_url.rsplit("/", 1)[-1].rsplit(".", 1)[0]).strip("-")
    digest = hashlib.sha256(video_url.encode("utf-8")).hexdigest()[:8]
    return f"{_DOC_DIR}/{(stem[:_STEM_CHARS] or 'video')}-{digest}.md"


def _principal(ctx: RunContext[AgentDepsT]) -> Principal:
    """取这次运行的可信主体。

    deps 不是 ``AgentRunDeps`` 说明运行身份没注进来，那是装配 bug 不是模型的输入
    错误，所以让它炸，不翻成一句可重试的提示。
    """

    deps = ctx.deps
    if not isinstance(deps, AgentRunDeps):
        raise RuntimeError(
            f"这次运行的 deps 是 {type(deps).__name__}，不是 AgentRunDeps——运行身份没有注入进来。"
        )
    return deps.principal


def _require_http(url: str, *, what: str) -> None:
    if not url.startswith(("http://", "https://")):
        raise ModelRetry(f"{what}必须是 http:// 或 https:// 开头；收到的是 {url!r}。")


def _check_in_range(rows: Sequence[Sequence[ShotSpan]], *, duration_ms: int) -> None:
    # 容 500ms：拆解文档的末镜头终点常常写到时长那一刻的取整之外。
    out_of_range = [shot for row in rows for shot in row if shot.end_ms > duration_ms + 500]
    if out_of_range:
        ids = ", ".join(str(shot.shot_id) for shot in out_of_range)
        raise ModelRetry(
            f"镜头时间戳越界（视频时长 {duration_ms}ms）：镜头 {ids}。对着拆解文档核一遍，"
            "用 edit_file 就地改正后重新调用。"
        )


def _resolve_requests(
    frames: Sequence[FrameRequest], document: dict[str, Any]
) -> tuple[list[str], list[str]]:
    """校验逐格请求并解出选中的帧号。"""

    if not 1 <= len(frames) <= GRID_CELLS:
        raise ModelRetry(f"frames 必须是 1-{GRID_CELLS} 条，当前 {len(frames)} 条。")
    known = {cell["id"] for board in document["boards"] for cell in board["cells"]}
    cell_ids: list[str] = []
    prompts: list[str] = []
    for position, request in enumerate(frames, start=1):
        cell_id = request.no.strip()
        try:
            parse_cell_id(cell_id)
        except ShotParseError as exc:
            raise ModelRetry(str(exc)) from exc
        if cell_id not in known:
            raise ModelRetry(
                f"帧号 {cell_id} 不在取帧账本中；可用帧号见预览板标注（本次共 {len(known)} 格）。"
            )
        if cell_id in cell_ids:
            raise ModelRetry(f"帧号 {cell_id} 在同一次调用中重复。")
        prompt = request.prompt.strip()
        if not prompt:
            raise ModelRetry(f"第 {position} 条（{cell_id}）的 prompt 为空。")
        cell_ids.append(cell_id)
        prompts.append(prompt)
    return cell_ids, prompts


def _failed_payload(error: str) -> dict[str, Any]:
    """生成未收敛时的返回值。"""

    return {
        "message": f"生成失败：{error}",
        "status": _STATUS_FAILED,
        "frames": [],
        "error": error,
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def shot_video_capability(
    *,
    generations: ImageGenerations,
    objects: PublicObjectWriter,
    understanding: VideoUnderstanding,
    client: httpx.AsyncClient,
    policy: GenerationPolicy | None = None,
) -> ShotVideo[Any]:
    """造一个镜头素材能力。组合根用这个，不直接碰 dataclass 的字段顺序。"""

    return ShotVideo[Any](
        generations=generations,
        objects=objects,
        understanding=understanding,
        client=client,
        policy=policy if policy is not None else GenerationPolicy(),
    )


__all__ = [
    "CAPABILITY_ID",
    "EXTRACTION_PATH",
    "GRID_RECORDS_DIR",
    "GRID_RESOLUTION",
    "VIEW_MAX_EDGE",
    "FrameRequest",
    "GenerationPolicy",
    "ShotVideo",
    "ShotVideoToolset",
    "shot_video_capability",
    "video_doc_path",
]
