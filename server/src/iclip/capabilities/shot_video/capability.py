"""镜头素材能力：拆参考片、取帧、出图、切格。

四件工具串成一条产线，但**不共享任何隐藏状态**——上一件的产物（时间码、URL）就是
下一件的入参。时间码由模型自己从拆解文档里挑出来传进来，不走「上一件写个约定路
径的文件、下一件去读」那条路：那种文件模型能改能删，而且同一件事两处各存一份必
然分叉。
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Final

import httpx
from pydantic_ai import ModelRetry, ToolReturn
from pydantic_ai.agent.abstract import AgentInstructions
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import BinaryContent
from pydantic_ai.tools import AgentDepsT, RunContext
from pydantic_ai.toolsets import AgentToolset, FunctionToolset

from iclip.capabilities.shot_video import ffmpeg
from iclip.capabilities.shot_video.grid import (
    MAX_GRID_SIDE,
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
)
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.public import Principal

CAPABILITY_ID: Final = "shot_video"

MAX_FRAMES_PER_CALL: Final = 8
"""一次抽帧最多取几帧。帧要附进模型上下文，几十张一次既贵又没法逐张判断。"""

MAX_ATTACHED_IMAGES: Final = 8
VIEW_MAX_EDGE: Final = 1024
"""附给模型看的那份图的长边像素。交付用的原图另存，不受这个限制。"""

_JPEG: Final = "image/jpeg"
_FRAME_PREFIX: Final = "shot-video/frames"
_CELL_PREFIX: Final = "shot-video/cells"

_TIMECODE = re.compile(r"^(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?$")
"""``分:秒`` 或 ``分:秒.毫秒``，与拆解文档里镜头时间码的写法一致。"""

_RESENDABLE: Final = frozenset({"PROVIDER_UNREACHABLE", "PROVIDER_SERVER_ERROR"})
"""哪些失败可以自动再发一次。

**判据只有一条：这次失败有没有可能已经计费。** 连不上、对方 5xx 没产出——这两
种确定没扣钱。其余一律停手报错：``PROVIDER_RESULT_UNKNOWN`` 可能已扣过钱，
``OUTPUT_*`` 是图出了只是没转存成功，重发都等于为同一张图付两次。
"""


@dataclass(frozen=True, slots=True)
class GenerationPolicy:
    """出图的重试与升级节奏：先 dev 试满 ``dev_attempts`` 次，再升 pro。

    **升级只在失败时发生。** 「出了图但不够好」是一次新需求，不该在这里悄悄换
    个更贵的渠道重来。
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
        # 三个依赖都是运行期对象（服务、连接池），从 YAML spec 里造不出来。
        return None


class ShotVideoToolset(FunctionToolset[AgentDepsT]):
    """四件工具。"""

    def __init__(self, capability: ShotVideo[AgentDepsT]) -> None:
        super().__init__(id=CAPABILITY_ID)
        self._cap = capability
        self.add_function(self.parse_video, name="parse_video")
        self.add_function(self.extract_video_frames, name="extract_video_frames")
        self.add_function(self.generate_image, name="generate_image")
        self.add_function(self.cut_grid_image, name="cut_grid_image")

    async def parse_video(self, ctx: RunContext[AgentDepsT], video_url: str) -> str:
        """拆解一段参考视频，返回一份逐镜拆解文档。

        - 文档含商业目的、结构分段、出场清单和逐镜拉片表，镜头时间码写成
          ``[00:03.800-00:05.600]``。
        - 同一段视频不要重复拆解。

        Args:
            ctx: 框架给的运行上下文。
            video_url: 视频地址，逐字取自对话里给你的那个。
        """

        _ = _principal(ctx)
        _require_http(video_url, what="视频地址")
        try:
            return await self._cap.understanding.parse(video_url)
        except VideoUnderstandingError as exc:
            raise ModelRetry(f"这段视频没拆解成功：{exc}") from exc

    async def extract_video_frames(
        self, ctx: RunContext[AgentDepsT], video_url: str, timestamps: list[str]
    ) -> ToolReturn:
        """按时间码从视频里取帧，返回每帧的地址，画面一并附在结果里。

        - 时间码逐字取自拆解文档或对话，不要自己估。
        - 一次最多 8 个时间码；要更多就拆成几次调用，在同一轮里并行发。

        Args:
            ctx: 框架给的运行上下文。
            video_url: 视频地址，逐字取自对话或 `parse_video` 用过的那个。
            timestamps: 要取哪几个时刻，写成 ``分:秒.毫秒``，如 ``00:03.800``。
        """

        _ = _principal(ctx)
        _require_http(video_url, what="视频地址")
        positions = _timestamps_ms(timestamps)
        try:
            async with ffmpeg.fetched(
                self._cap.client, video_url, max_bytes=ffmpeg.MAX_VIDEO_BYTES, suffix=".mp4"
            ) as source:
                duration = await ffmpeg.probe_duration_ms(source)
                for label, position in zip(timestamps, positions, strict=True):
                    if position >= duration:
                        raise ModelRetry(
                            f"{label} 超出了视频时长（这段片子 {_format_ms(duration)}）。"
                            "对着拆解文档里的时间码再确认一遍。"
                        )
                frames = [
                    await ffmpeg.frame_at(source, position_ms=position) for position in positions
                ]
        except ffmpeg.MediaError as exc:
            raise ModelRetry(str(exc)) from exc
        uploaded = await asyncio.gather(
            *(self._store(frame, prefix=_FRAME_PREFIX) for frame in frames)
        )
        lines = [f"{label}\t{url}" for label, url in zip(timestamps, uploaded, strict=True)]
        return ToolReturn(
            return_value="取到这几帧（时间码 → 地址）：\n" + "\n".join(lines),
            content=await self._views(frames),
        )

    async def generate_image(
        self,
        ctx: RunContext[AgentDepsT],
        prompt: str,
        aspect_ratio: str,
        resolution: str = "1k",
        reference_image_urls: list[str] | None = None,
    ) -> str:
        """生成一张图，返回它的地址。

        - 同一份需求不要重复调用——每次调用都会重新生成一张，不会返回上次的结果。
          出的图不满意就改 prompt 再调。
        - 参考图地址逐字取自工具结果或对话，不要自己构造。
        - 出图要几分钟，调用会阻塞等到有结果。超时返回的不是「没生成」——那次可能
          还在后台跑，不要马上重发。

        Args:
            ctx: 框架给的运行上下文。
            prompt: 画面描述。
            aspect_ratio: 画幅，如 ``9:16`` / ``16:9`` / ``1:1``。
            resolution: 出图档位，``1k`` / ``2k`` / ``4k``。
            reference_image_urls: 参考图地址；留空即纯文生图。
        """

        principal = _principal(ctx)
        references = tuple(reference_image_urls or ())
        for url in references:
            _require_http(url, what="参考图地址")
        attempts: list[str] = []
        deadline = asyncio.get_running_loop().time() + self._cap.policy.total_timeout_seconds
        channels = self._cap.policy.channels()
        for index, channel in enumerate(channels):
            try:
                job = await self._run_one(
                    principal,
                    ImageRequest(
                        prompt=prompt,
                        aspect_ratio=aspect_ratio,
                        resolution=resolution,
                        channel=channel,
                        reference_image_urls=references,
                    ),
                    deadline=deadline,
                )
            except InvalidImageRequest as exc:
                # 参数不合规是在提交之前拒的，一分钱没花，所以让模型改了重来。
                raise ModelRetry(str(exc)) from exc
            if job.status == "completed" and job.output_url:
                return _outcome(job, attempts, done=True)
            last = index == len(channels) - 1
            if last or job.error_code not in _RESENDABLE:
                return _outcome(job, attempts, done=False)
            # 这一条要在决定收手之后才记：收手时的失败由 headline 说，attempts
            # 只列它之前的那几次，否则最后一次会被说两遍。
            attempts.append(f"{channel} 渠道（{job.job_id}）：{job.error_code or '没给出结果'}")
            await asyncio.sleep(
                self._cap.policy.backoff_seconds * self._cap.policy.backoff_factor**index
            )
        raise AssertionError("重试策略至少要有一个渠道")

    async def cut_grid_image(
        self,
        ctx: RunContext[AgentDepsT],
        image_url: str,
        rows: int = 2,
        cols: int = 2,
        target_aspect: str | None = None,
    ) -> ToolReturn:
        """把一张网格拼图切成单张，返回每格的地址，画面一并附在结果里。

        - 只对 `generate_image` 出的拼图用，``image_url`` 逐字取自它的结果。
        - 结果会说明这次是按图上的网格线切的、还是退回了等分。**退回等分时先看
          一眼图再用**：那种情况单格可能带白边或错半格。

        Args:
            ctx: 框架给的运行上下文。
            image_url: 拼图地址。
            rows: 几行。
            cols: 几列。
            target_aspect: 目标画幅，如 ``9:16``。给了就把每格居中裁到这个画幅，
                不给就保留切出来的原始比例。
        """

        _ = _principal(ctx)
        _require_http(image_url, what="图片地址")
        if not 1 <= rows <= MAX_GRID_SIDE or not 1 <= cols <= MAX_GRID_SIDE:
            raise ModelRetry(f"rows 与 cols 都要在 1 到 {MAX_GRID_SIDE} 之间。")
        try:
            async with ffmpeg.fetched(
                self._cap.client, image_url, max_bytes=ffmpeg.MAX_IMAGE_BYTES, suffix=".img"
            ) as source:
                gray, full_width = await ffmpeg.decode_gray(source)
                layout = grid_cell_boxes(gray, rows=rows, cols=cols)
                boxes = [
                    scale_box(box, from_width=gray.width, to_width=full_width)
                    for box in layout.boxes
                ]
                if target_aspect is not None:
                    ratio = parse_aspect(target_aspect)
                    boxes = [fit_box_to_aspect(box, ratio) for box in boxes]
                cells = await ffmpeg.crop_cells(source, boxes)
        except (ffmpeg.MediaError, GridError) as exc:
            raise ModelRetry(str(exc)) from exc
        uploaded = await asyncio.gather(*(self._store(cell, prefix=_CELL_PREFIX) for cell in cells))
        note = (
            "按图上真实的网格线切的。"
            if layout.detected
            else "没找到清晰的网格线，退回了等分——单格可能带白边或错半格，用之前先看一眼。"
        )
        lines = [f"第 {index + 1} 格\t{url}" for index, url in enumerate(uploaded)]
        return ToolReturn(
            return_value=f"切出 {len(uploaded)} 格。{note}\n" + "\n".join(lines),
            content=await self._views(cells),
        )

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

    async def _store(self, data: bytes, *, prefix: str) -> str:
        """把字节放到公开地址上；key 用内容哈希，同一帧再取一次不会在桶里堆重复。"""

        digest = hashlib.sha256(data).hexdigest()
        return await self._cap.objects.put_public_object(
            object_key=f"{prefix}/{digest}.jpg", content=data, content_type=_JPEG
        )

    async def _views(self, images: Sequence[bytes]) -> list[Any]:
        """缩出给模型看的那一份；交付用的原图已经落在对象存储上了。"""

        try:
            shrunk = await asyncio.gather(
                *(
                    ffmpeg.shrink(item, max_edge=VIEW_MAX_EDGE)
                    for item in images[:MAX_ATTACHED_IMAGES]
                )
            )
        except ffmpeg.MediaError as exc:
            raise ModelRetry(str(exc)) from exc
        return [BinaryContent(data=item, media_type=_JPEG) for item in shrunk]


def _principal(ctx: RunContext[AgentDepsT]) -> Principal:
    """取这次运行的可信主体。

    deps 不是 ``AgentRunDeps`` 说明运行身份没注进来，那是装配 bug 不是模型的输
    入错误，所以让它炸，不翻成一句可重试的提示。
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


def _timestamps_ms(timestamps: Sequence[str]) -> list[int]:
    if not timestamps:
        raise ModelRetry("至少给一个时间码。")
    if len(timestamps) > MAX_FRAMES_PER_CALL:
        raise ModelRetry(
            f"一次最多取 {MAX_FRAMES_PER_CALL} 帧；要更多就拆成几次调用（可以并行发）。"
        )
    positions: list[int] = []
    for value in timestamps:
        matched = _TIMECODE.match(value.strip())
        if matched is None:
            raise ModelRetry(f"时间码 {value!r} 看不懂，写成 分:秒.毫秒，比如 00:03.800。")
        minutes, seconds, millis = matched.groups()
        positions.append(
            int(minutes) * 60_000 + int(seconds) * 1000 + int((millis or "0").ljust(3, "0"))
        )
    return positions


def _format_ms(value: int) -> str:
    return f"{value // 60_000:02d}:{value % 60_000 / 1000:06.3f}"


def _outcome(job: ImageJob, attempts: Sequence[str], *, done: bool) -> str:
    """讲清结局，并列出之前试过几次——每一次都是一行记录，也都是一次可能的计费。"""

    trail = ("\n之前试过：\n" + "\n".join(attempts)) if attempts else ""
    if done:
        return f"出图完成（{job.channel} 渠道，记录 {job.job_id}）：{job.output_url}{trail}"
    return (
        f"出图失败（{job.channel} 渠道，记录 {job.job_id}）："
        f"{job.error_code or '未知'} {job.error_message or ''}".rstrip()
        + trail
    )


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
    "MAX_ATTACHED_IMAGES",
    "MAX_FRAMES_PER_CALL",
    "VIEW_MAX_EDGE",
    "GenerationPolicy",
    "ShotVideo",
    "ShotVideoToolset",
    "shot_video_capability",
]
