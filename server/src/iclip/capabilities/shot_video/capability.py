"""镜头素材能力：拆参考片、等间隔取帧分板、按批出帧、补拍设定图、读图、交付镜头组。

六件工具靠工作区里的几份文件接力：拆解文档（`video/<名>.md`）、取帧账本
（`frames/extraction.json`）、逐批版记录（`frames/grids/`、`anchors/`），终点是
`video_shot.json`。落在哪由构造时给进来的 `FileSpace` 决定，和工作区能力收的是同
一个——所以模型用 `read_file` / `edit_file` 看见的就是这几件工具写的那批文件，时
间码写坏了它自己就能修。本包不认识工作区能力。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from collections.abc import Iterable, Mapping, Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass, field, replace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Final

import httpx
from pydantic import BaseModel
from pydantic_ai import ModelRetry
from pydantic_ai.agent.abstract import AgentInstructions
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import ImageUrl, ToolReturn
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
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
    ObjectWriteFailed,
    PublicObjectWriter,
    ShotVideoPaths,
    VideoUnderstanding,
)
from iclip.capabilities.shot_video.prompt import (
    GRID_CELLS,
    GRID_COLS,
    GRID_ROWS,
    assemble_anchor_prompt,
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
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.public import Principal
from iclip.harness.materials import RunMaterials, run_materials
from iclip.harness.media import (
    IMAGE_CONTEXT_MAX_EDGE,
    MediaKind,
    media_kind_label,
    media_tag_close,
    media_tag_open,
    resized_image_url,
)
from iclip.platform.file_store.store import FileSpace, FileStore, QuotaExceeded
from iclip.platform.transcript.display import (
    DisplayFn,
    FileIoDisplay,
    GenericDisplay,
    MediaGridItem,
    MediaGridItems,
    ToolDisplay,
    ToolDisplayEntry,
    UrlFetchDisplay,
)

CAPABILITY_ID: Final = "shot_video"

EXTRACTION_PATH: Final = "frames/extraction.json"
EXTRACTION_VERSION: Final = 1
GRID_RECORDS_DIR: Final = "frames/grids"
GRID_RECORD_VERSION: Final = 1
ANCHOR_RECORDS_DIR: Final = "anchors"
ANCHOR_RECORD_VERSION: Final = 1
SHOTS_PATH: Final = "video_shot.json"

GRID_RESOLUTION: Final = "4k"
"""整图按最高档出。切成 4 格后每格只剩四分之一线性分辨率，低档不够交付。"""

ANCHOR_ASPECT: Final = "1:1"
"""补拍整版的画幅。方版分四格后每格也接近方形，站得下全身像也放得下空景。

补拍出来的是参考图，不是要交付的画面，所以不跟目标画幅走——按 9:16 出一版再切，
每格会窄到只剩一条。切格后也不再按画幅收缩：那一刀裁掉的是实体本身。
"""

SHOT_MIN_SECONDS: Final = 4
SHOT_MAX_SECONDS: Final = 30

_JPEG: Final = "image/jpeg"
_DOC_DIR: Final = "video"

_IMAGE_REF = re.compile(r"@Image(\d+)")
"""镜头组 prompt 里指向参考图的记号。"""

_UNSAFE_STEM = re.compile(r"[^A-Za-z0-9_-]+")
_STEM_CHARS: Final = 40

_STATUS_DONE: Final = "done"
_STATUS_FAILED: Final = "failed"

_MEDIA_GRID_VIEW: Final = "media_grid"
"""三件出图 / 拼板工具的结果用这个渲染器画，形状是 ``MediaGridItems``。"""

_EVEN_SPLIT_NOTICE: Final = (
    " 整图没找到清晰的网格线，按等分切的——单格可能带白边或错半格，用之前先看一眼。"
)


class FrameRequest(BaseModel):
    """一格的生成请求。"""

    no: str
    prompt: str


class VideoShotRequest(BaseModel):
    """一个镜头组的交付内容。"""

    index: int
    prompt: str
    seconds: int
    image_urls: list[str]


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


@dataclass
class ShotVideo(AbstractCapability[AgentDepsT]):
    """把六件工具挂到 agent 上。"""

    space: FileSpace
    """拆解文档、账本与镜头组产物落在哪。必须和工作区能力收的是同一个。

    「同一个」由组合根保证：这里只认平台层这一件东西，不认识工作区能力。两边要
    是各接各的，文档照写照读，只是模型的 ``read_file`` 看不见它——失效是静默的。
    """

    generations: ImageGenerations
    objects: PublicObjectWriter
    paths: ShotVideoPaths
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

    def display_table(self) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        """这六件工具的卡怎么画、结果用哪个渲染器画。组合根装配期取一次，合进那份注册表。"""

        return {
            "video_parser_md": lambda _args: GenericDisplay(summary="拆解参考片"),
            "plan_shot_frames": ToolDisplayEntry(
                draw=lambda _args: GenericDisplay(summary="按镜头取帧拼板"), view=_MEDIA_GRID_VIEW
            ),
            "generate_shot_frames": ToolDisplayEntry(draw=_frames_display, view=_MEDIA_GRID_VIEW),
            "generate_anchor_sheet": ToolDisplayEntry(
                draw=lambda _args: GenericDisplay(summary="补拍设定图"), view=_MEDIA_GRID_VIEW
            ),
            "ReadMediaFile": _media_display,
            "write_video_shots": lambda _args: FileIoDisplay(operation="write", path=SHOTS_PATH),
        }

    @classmethod
    def get_serialization_name(cls) -> str | None:
        # 依赖都是运行期对象（服务、连接池），从 YAML spec 里造不出来。
        return None


class ShotVideoToolset(FunctionToolset[AgentDepsT]):
    """六件工具。参数的范围规则挂在登记处的验证器上，工具体只做本职。

    六件都经 ``Tool`` 登记，不走 ``add_function``：后者的参数表由 pyright 从函数推，收 ``ctx``
    的工具会把 ``ctx`` 也算进参数表，于是任何一个签名正确的验证器都被判不兼容。
    代价是工具集级别的默认值（``strict`` / ``sequential`` / ``requires_approval`` / ``timeout``
    等）不再套到这六件上——这里只传 ``id``，所以现在没有差别；将来在 ``super().__init__``
    上加一个默认值，它对这六件会静默失效。
    """

    def __init__(self, capability: ShotVideo[AgentDepsT]) -> None:
        super().__init__(id=CAPABILITY_ID)
        self._cap = capability
        self.add_tool(
            Tool(
                self.video_parser_md,
                name="video_parser_md",
                args_validator=_validate_video_url,
            )
        )
        self.add_tool(
            Tool(
                self.plan_shot_frames,
                name="plan_shot_frames",
                args_validator=_validate_video_url,
            )
        )
        self.add_tool(
            Tool(
                self.generate_shot_frames,
                name="generate_shot_frames",
                args_validator=_validate_frame_generation,
            )
        )
        self.add_tool(Tool(self.generate_anchor_sheet, name="generate_anchor_sheet"))
        self.add_tool(
            Tool(self.read_media_file, name="ReadMediaFile", args_validator=_validate_image_url)
        )
        self.add_tool(Tool(self.write_video_shots, name="write_video_shots"))

    async def video_parser_md(self, ctx: RunContext[AgentDepsT], video_url: str) -> dict[str, Any]:
        """拆解一段参考视频，把拆解文档写进工作区，返回它的路径。

        - 文档含商业目的、结构分段、出场清单、逐镜拉片表和剪辑形式，镜头时间码写成
          ``**[00:03.800-00:05.600]**``。
        - 同一段视频不要重复拆解——每次调用都是一次新的拆解，不复用上次结果。
        - 文档正文不随本工具返回；要看内容用 `read_file` 读返回的路径。
        - 只接受这段对话里出现过的视频地址；自己拼的、以及对话里那些图片的地址，
          都会被拒。

        Args:
            ctx: 框架给的运行上下文。
            video_url: 视频地址，逐字取自对话里给你的那个。
        """

        files, namespace = self._workspace(ctx)
        path = video_doc_path(video_url)
        try:
            content = await self._cap.understanding.parse(video_url)
        except VideoUnderstandingError as exc:
            raise ModelRetry(f"这段视频没拆解成功：{exc}") from exc
        await self._write(files, namespace, path, content)
        return {"message": f"视频解析完毕，拆解结果已保存到 {path}。", "path": path}

    async def plan_shot_frames(
        self, ctx: RunContext[AgentDepsT], video_url: str
    ) -> ToolReturn[dict[str, Any]] | dict[str, Any]:
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
        - 只接受这段对话里出现过的视频地址；自己拼的、以及对话里那些图片的地址，
          都会被拒。

        Args:
            ctx: 框架给的运行上下文。
            video_url: 参考视频地址，逐字取自对话里给你的那个。
        """

        files, namespace = self._workspace(ctx)
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
        except ObjectWriteFailed as exc:
            raise ModelRetry(
                f"候选帧预览板没存进对象存储：{exc}。重新调用一次；已经存下的板会直接复用，不重传。"
            ) from exc
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
        return ToolReturn(
            return_value={
                "message": message,
                "boards": [
                    {"board": board["board"], "shots": board["shots"], "url": board["url"]}
                    for board in boards
                ],
            },
            metadata=_media_grid(
                (board["url"], f"板 {board['board']} · {','.join(map(str, board['shots']))}")
                for board in boards
            ),
        )

    async def generate_shot_frames(
        self,
        ctx: RunContext[AgentDepsT],
        frames: list[FrameRequest],
        reference_images: list[str],
        global_reference: str,
        target_aspect: str,
    ) -> ToolReturn[dict[str, Any]] | dict[str, Any]:
        """按逐帧 visual_prompt 生成镜头帧：一次调用出一张 2×2 网格图、切成 4 帧返回逐帧 URL。

        - frames 每条给一个定格：`no` 是 S8-1 形状的帧号，镜头号即它所属的镜头，挑
          中候选帧的直接用板上的帧号；prompt 是为它撰写的 visual_prompt。
        - 一批 1-4 条；不足 4 条时空格由中性面板补满并在切格后丢弃。
        - reference_images 的顺序即 global_reference 中 @Image1..N 的编号。
        - 需要多次调用时，在同一次回复中并行发起，不要串行等待。
        - 生成需要数分钟，调用会阻塞到收敛后返回。
        - 每次调用都重新提交生成，没有复用；同一批帧不满意就改 prompt 再调。
        - 参考图只接受这段对话里出现过的地址；自己拼的、以及对话里那些视频的地
          址，都会被拒。
        - 每批成功后把逐帧 no/shot/prompt/url 与本批入参写进版记录
          ``frames/grids/<jobId>.json``。
        - 该视频尚未抽帧、帧号格式错误或同批重复时返回错误。

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
        cell_ids, prompts = _resolve_requests(frames)
        references = tuple(reference_images)
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

    async def generate_anchor_sheet(
        self, ctx: RunContext[AgentDepsT], cells: list[str]
    ) -> ToolReturn[dict[str, Any]] | dict[str, Any]:
        """按文字补拍设定图：一次调用出一张 2×2 网格图、切成 4 格返回逐格 URL。

        - 一格一个实体，cells 每条是那一格画面的完整描述；返回的 `index` 就是它在
          cells 里的位置。
        - 一批 1-4 条；不足 4 条时空格由中性面板补满并在切格后丢弃。
        - 本工具不收参考图，每格的文字就是那一格的全部依据。要按已有的图生成画面
          用 `generate_shot_frames`。
        - 需要多次调用时，在同一次回复中并行发起，不要串行等待。
        - 生成需要数分钟，调用会阻塞到收敛后返回。
        - 每次调用都重新提交生成，没有复用；同一批实体不要补拍第二次。
        - 每批成功后把逐格 index/description/url 写进版记录
          ``anchors/<jobId>.json``。

        Args:
            ctx: 框架给的运行上下文。
            cells: 逐格描述，1-4 条。
        """

        files, namespace = self._workspace(ctx)
        principal = _principal(ctx)
        descriptions = _resolve_cells(cells)
        job = await self._generate(
            principal,
            ImageRequest(
                prompt=assemble_anchor_prompt(cells=descriptions, target_aspect=ANCHOR_ASPECT),
                aspect_ratio=ANCHOR_ASPECT,
                resolution=GRID_RESOLUTION,
                channel="dev",
            ),
        )
        if job.status != "completed" or not job.output_url:
            return _failed_payload(
                f"{job.error_code or '未知'} {job.error_message or ''}".rstrip()
                + f"（{job.channel} 渠道，记录 {job.job_id}）",
                items_key="images",
            )
        return await self._collect_anchors(files, namespace, job, descriptions=descriptions)

    async def read_media_file(self, ctx: RunContext[AgentDepsT], url: str) -> list[str | ImageUrl]:
        """读取一张图片，原始内容以多模态形式附在工具结果中。

        - 本工具通常是你会希望并行使用的工具：需要看多张图时在同一次回复中发起多
          次调用，不要分多轮逐张读取。
        - 已读取且仍在上下文中的图片不要重复读取。
        - 本工具只读图片。视频信息读拆解文档，文本与产物文件用 `read_file`。
        - 只接受这段对话里出现过的地址；自行构造的一律被拒。上下文里已经翻不到那
          个地址时，用 `read_file` 读回记着它的那份账本或版记录。

        Args:
            ctx: 框架给的运行上下文。
            url: 图片地址，逐字取自对话或本会话工具结果里的图片 URL，不要自行构造。
        """

        _ = _principal(ctx)
        # 附地址而不是字节：厂商自己去取图，我们既不下载也不转码。缩放交给 OSS 的
        # 参数（见 resized_image_url），附的是缩略档，tag 里写的仍是原图地址。
        try:
            view = ImageUrl(url=resized_image_url(url, max_edge=IMAGE_CONTEXT_MAX_EDGE))
            _ = view.media_type
        except ValueError as exc:
            raise ModelRetry(f"这张图读不了（{exc}）") from exc
        # 三段直接当返回值，于是它们留在这条工具结果里。换成 ToolReturn(content=...)
        # 的话，官方会把多模态那份接成紧随其后的一条**用户**消息——模型会读到一条用户
        # 没发过的消息，历史里也多出一条。
        #
        # 像素包在一对 tag 中间：地址与它显示的那张图是连着的一段，模型要把这张图交
        # 给别的工具时，抄的是 tag 里的原图地址而不是缩略档。
        return [media_tag_open("image", url), view, media_tag_close("image")]

    async def write_video_shots(
        self,
        ctx: RunContext[AgentDepsT],
        aspect_ratio: str,
        shots: list[VideoShotRequest],
    ) -> dict[str, Any]:
        """交付镜头组 prompt 表：校验后写成工作区里的 ``video_shot.json``。

        - 镜头组 prompt 表只经本工具交付。不要用 `write_file` 写 ``video_shot.json``
          或它的副本。
        - `index` 从 1 连续编号，`seconds` 是 4-30 的整数。
        - `image_urls` 只收 `generate_shot_frames` 生成过的镜头帧地址；自己拼的、
          以及对话里那些素材图的地址都会被拒。上下文里翻不到时用 `read_file` 读
          ``frames/grids/`` 下的版记录取回来。
        - `image_urls` 的顺序即 prompt 里 ``@Image1..N`` 的编号，写到的最大编号不
          得超过这一组的张数。
        - 每次调用整份覆盖，不是追加：重做时把全部镜头组一起传。
        - 任一条不合规即整份拒收，不会写下半份。

        Args:
            ctx: 框架给的运行上下文。
            aspect_ratio: 目标画幅，如 ``9:16``。
            shots: 逐个镜头组，按 index 顺序排列。
        """

        files, namespace = self._workspace(ctx)
        try:
            parse_aspect(aspect_ratio)
        except GridError as exc:
            raise ModelRetry(str(exc)) from exc
        rows = _resolve_shots(shots, known=await self._known_frame_urls(files, namespace))
        await self._write(
            files,
            namespace,
            SHOTS_PATH,
            json.dumps({"aspectRatio": aspect_ratio, "shots": rows}, ensure_ascii=False, indent=2),
        )
        seconds = sum(shot.seconds for shot in shots)
        return {
            "message": (
                f"镜头组 prompt 表已交付到 {SHOTS_PATH}：{len(rows)} 个镜头组，合计 {seconds} 秒。"
            ),
            "path": SHOTS_PATH,
        }

    async def _known_frame_urls(self, files: FileStore, namespace: str) -> set[str]:
        """本次对话已经生成过的镜头帧地址，从逐批版记录里收。

        以版记录为准而不是取帧账本：账本里的是参考视频的候选帧，不是生成出来的镜
        头帧，交付的必须是后者。
        """

        urls: set[str] = set()
        for entry in await files.entries(namespace, prefix=GRID_RECORDS_DIR):
            stored = await files.read(namespace, entry.path)
            if stored is None:
                continue
            try:
                record = json.loads(stored.content)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            frames = record.get("frames")
            if not isinstance(frames, list):
                continue
            for frame in frames:
                if isinstance(frame, dict):
                    url = frame.get("url")
                    if isinstance(url, str):
                        urls.add(url)
        return urls

    async def _shot_rows(
        self, files: FileStore, namespace: str, doc_path: str
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
                    object_key=self._cap.paths.shot_board(extraction_key=key, index=index),
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
        """提交出图，失败就沿 dev→dev→pro 往下试，返回成功那次或最后那次的结局。"""

        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._cap.policy.total_timeout_seconds
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
            # 时限用尽就不再提交下一个——提交了也等不到结果。
            if index == len(channels) - 1 or loop.time() >= deadline:
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
        files: FileStore,
        namespace: str,
        job: ImageJob,
        *,
        cell_ids: Sequence[str],
        prompts: Sequence[str],
        references: Sequence[str],
        global_reference: str,
        target_aspect: str,
    ) -> ToolReturn[dict[str, Any]] | dict[str, Any]:
        """取整图、切格、逐帧落公开地址、写版记录。补位的中性面板格在此丢弃。"""

        grid_url = job.output_url
        if not grid_url:
            return _failed_payload("生成记录未携带结果 URL")
        try:
            cells, detected = await self._slice_grid(grid_url, aspect=target_aspect)
        except (ffmpeg.MediaError, GridError) as exc:
            return _failed_payload(str(exc))
        if len(cells) != GRID_CELLS:
            return _failed_payload("整图切格数量异常")

        try:
            urls = await self._put_all(
                [
                    (self._cap.paths.shot_cell(job_id=job.job_id, cell_id=cell_id), cell)
                    for cell_id, cell in zip(cell_ids, cells, strict=False)
                ]
            )
        except ObjectWriteFailed as exc:
            return _unstored_payload(exc, job)
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
        if not detected:
            message += _EVEN_SPLIT_NOTICE
        return ToolReturn(
            return_value={
                "message": message,
                "status": _STATUS_DONE,
                "frames": frames_payload,
                "record": record_path,
                "error": None,
            },
            metadata=_media_grid(zip(urls, cell_ids, strict=True)),
        )

    async def _collect_anchors(
        self,
        files: FileStore,
        namespace: str,
        job: ImageJob,
        *,
        descriptions: Sequence[str],
    ) -> ToolReturn[dict[str, Any]] | dict[str, Any]:
        """取整图、切格、逐格落公开地址、写版记录。补位的中性面板格在此丢弃。

        切格后不按画幅收缩：补拍出来的是参考图，那一刀裁掉的会是实体本身。
        """

        grid_url = job.output_url
        if not grid_url:
            return _failed_payload("生成记录未携带结果 URL", items_key="images")
        try:
            cells, detected = await self._slice_grid(grid_url, aspect=None)
        except (ffmpeg.MediaError, GridError) as exc:
            return _failed_payload(str(exc), items_key="images")
        if len(cells) != GRID_CELLS:
            return _failed_payload("整图切格数量异常", items_key="images")

        try:
            urls = await self._put_all(
                [
                    (self._cap.paths.anchor_sheet(job_id=job.job_id, index=index), cell)
                    for index, cell in enumerate(cells[: len(descriptions)], start=1)
                ]
            )
        except ObjectWriteFailed as exc:
            return _unstored_payload(exc, job, items_key="images")
        images = [{"index": index, "url": url} for index, url in enumerate(urls, start=1)]
        record_path = f"{ANCHOR_RECORDS_DIR}/{job.job_id}.json"
        record = {
            "anchorRecordVersion": ANCHOR_RECORD_VERSION,
            "jobId": str(job.job_id),
            "gridUrl": grid_url,
            "sheetAspect": ANCHOR_ASPECT,
            "cells": [
                {**image, "description": description}
                for image, description in zip(images, descriptions, strict=True)
            ],
            "createdAt": int(time.time()),
        }
        await self._write(
            files, namespace, record_path, json.dumps(record, ensure_ascii=False, indent=2)
        )
        message = f"补拍完成 {len(images)} 格（{job.channel} 渠道），版记录见 {record_path}。"
        if not detected:
            message += _EVEN_SPLIT_NOTICE
        return ToolReturn(
            return_value={
                "message": message,
                "status": _STATUS_DONE,
                "images": images,
                "record": record_path,
                "error": None,
            },
            # 标题取那一格的描述：``images`` 里只有序号和地址，描述在入参上。
            metadata=_media_grid(zip(urls, descriptions, strict=True)),
        )

    async def _put_all(self, cells: Sequence[tuple[str, bytes]]) -> list[str]:
        """把切出来的格并行落公开地址，按原顺序返回地址。

        等全部收尾再报第一个失败：默认的 gather 在第一个失败时就抛，其余还在跑的上传
        就成了没人认领的任务，它们随后的失败只会在日志里留一句「异常从未被取回」。
        """

        results = await asyncio.gather(
            *(
                self._cap.objects.put_public_object(
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
            self._cap.client, grid_url, max_bytes=ffmpeg.MAX_IMAGE_BYTES, suffix=".img"
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

    async def _load_extraction(
        self, files: FileStore, namespace: str, *, expected_key: str | None
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

    async def _write(self, files: FileStore, namespace: str, path: str, content: str) -> None:
        try:
            await files.write(namespace, path, content)
        except QuotaExceeded as exc:
            raise ModelRetry(f"工作区写不下 {path}：{exc} 用 delete_file 清掉不用的文件。") from exc

    def _workspace(self, ctx: RunContext[AgentDepsT]) -> tuple[FileStore, str]:
        """这次运行的文件存储与命名空间。命名空间算不出来就让它抛，不退回公共的。"""

        return self._cap.space.store, self._cap.space.resolve(ctx)


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


def _validate_video_url(ctx: RunContext[Any], video_url: str) -> None:
    """拆片与取帧收的视频地址。签名与这两件工具（去掉 ``self``）逐字一致，官方按它调。"""

    _require_http(video_url, what="视频地址")
    _require_material(run_materials(ctx.messages), video_url, kind="video", what="视频地址")


def _validate_frame_generation(
    ctx: RunContext[Any],
    frames: list[FrameRequest],
    reference_images: list[str],
    global_reference: str,
    target_aspect: str,
) -> None:
    """出图收的参考图地址。

    ``frames`` 与画幅的规则要先读工作区里的账本，不是纯参数规则，留在工具体里；这几个参数在
    这里照收不看——签名必须与工具（去掉 ``self``）逐字一致。
    """

    _ = (frames, global_reference, target_aspect)
    materials = run_materials(ctx.messages)
    for url in reference_images:
        _require_http(url, what="参考图地址")
        _require_material(materials, url, kind="image", what="参考图地址")


def _validate_image_url(ctx: RunContext[Any], url: str) -> None:
    """读图收的地址。"""

    _require_http(url, what="图片地址")
    _require_material(run_materials(ctx.messages), url, kind="image", what="图片地址")


def _media_grid(items: Iterable[tuple[str, str]]) -> MediaGridItems:
    """把（地址，标题）拼成界面那份缩略图墙。三件工具共用，键名只写一遍。"""

    return {"items": [MediaGridItem(url=url, caption=caption) for url, caption in items]}


def _frames_display(args: Any) -> ToolDisplay:
    frames = args.get("frames") if isinstance(args, dict) else None
    return GenericDisplay(summary=f"出图 {len(frames)} 帧" if isinstance(frames, list) else "出图")


def _media_display(args: Any) -> ToolDisplay | None:
    url = args.get("url") if isinstance(args, dict) else None
    return UrlFetchDisplay(url=url) if isinstance(url, str) and url else None


def _require_http(url: str, *, what: str) -> None:
    if not url.startswith(("http://", "https://")):
        raise ModelRetry(f"{what}必须是 http:// 或 https:// 开头；收到的是 {url!r}。")


def _require_material(materials: RunMaterials, url: str, *, kind: MediaKind, what: str) -> None:
    """要求这个地址是本对话的素材：出现过；被声明过种类的，种类还得对得上。

    种类只在「声明过」时查：那个信息只有用户发的附件带得来（tag 写在上面），本能
    力自己产出的地址是裸的，对它们查种类等于把自己的产物拒在门外。

    错误消息一律**不回显被拒的地址**。回显了，模型重试一次就把它洗成上下文里出现
    过的东西了——下一次同样的调用就会放行。
    """

    if not materials.appears(url):
        known = materials.declared(kind)
        if known:
            raise ModelRetry(
                f"这个{what}不是这段对话里的素材。本对话的{media_kind_label(kind)}有："
                f"{'、'.join(known)}。逐字抄其中一个。"
            )
        raise ModelRetry(
            f"这个{what}不是这段对话里的素材。只能用对话里给你的地址、或工具结果里"
            f"返回的地址，不要自己拼；本能力写下的地址也记在 {EXTRACTION_PATH} 与 "
            f"{GRID_RECORDS_DIR}/ 下，用 read_file 读回来再用。"
        )
    declared = materials.kind_of(url)
    if declared is not None and declared != kind:
        raise ModelRetry(
            f"这个地址在对话里是一份{media_kind_label(declared)}，当不了{what}。"
            f"换一个{media_kind_label(kind)}的地址。"
        )


def _check_in_range(rows: Sequence[Sequence[ShotSpan]], *, duration_ms: int) -> None:
    # 容 500ms：拆解文档的末镜头终点常常写到时长那一刻的取整之外。
    out_of_range = [shot for row in rows for shot in row if shot.end_ms > duration_ms + 500]
    if out_of_range:
        ids = ", ".join(str(shot.shot_id) for shot in out_of_range)
        raise ModelRetry(
            f"镜头时间戳越界（视频时长 {duration_ms}ms）：镜头 {ids}。对着拆解文档核一遍，"
            "用 edit_file 就地改正后重新调用。"
        )


def _resolve_requests(frames: Sequence[FrameRequest]) -> tuple[list[str], list[str]]:
    """校验逐格请求并解出各格的帧号。

    帧号只查形状与同批重复，不查它是不是账本里的候选帧：候选帧是写 prompt 时看的参
    考，定格记的是属于哪一镜——新增的镜头、短于一秒的镜头没有候选帧，一样要出定格。
    """

    if not 1 <= len(frames) <= GRID_CELLS:
        raise ModelRetry(f"frames 必须是 1-{GRID_CELLS} 条，当前 {len(frames)} 条。")
    cell_ids: list[str] = []
    prompts: list[str] = []
    for position, request in enumerate(frames, start=1):
        cell_id = request.no.strip()
        try:
            parse_cell_id(cell_id)
        except ShotParseError as exc:
            raise ModelRetry(str(exc)) from exc
        if cell_id in cell_ids:
            raise ModelRetry(f"帧号 {cell_id} 在同一次调用中重复。")
        prompt = request.prompt.strip()
        if not prompt:
            raise ModelRetry(f"第 {position} 条（{cell_id}）的 prompt 为空。")
        cell_ids.append(cell_id)
        prompts.append(prompt)
    return cell_ids, prompts


def _resolve_cells(cells: Sequence[str]) -> list[str]:
    """校验补拍的逐格描述。"""

    if not 1 <= len(cells) <= GRID_CELLS:
        raise ModelRetry(f"cells 必须是 1-{GRID_CELLS} 条，当前 {len(cells)} 条。")
    descriptions: list[str] = []
    for position, cell in enumerate(cells, start=1):
        description = cell.strip()
        if not description:
            raise ModelRetry(f"第 {position} 格的描述为空。")
        descriptions.append(description)
    return descriptions


def _resolve_shots(
    shots: Sequence[VideoShotRequest], *, known: AbstractSet[str]
) -> list[dict[str, Any]]:
    """校验镜头组并整理成落文件的形状。有一条不合规就整份拒收。"""

    if not shots:
        raise ModelRetry("shots 一条都没有；镜头组 prompt 表不能是空的。")
    rows: list[dict[str, Any]] = []
    for position, shot in enumerate(shots, start=1):
        if shot.index != position:
            raise ModelRetry(f"index 要从 1 连续编号：第 {position} 条写的是 {shot.index}。")
        prompt = shot.prompt.strip()
        if not prompt:
            raise ModelRetry(f"镜头组 {shot.index} 的 prompt 为空。")
        if not SHOT_MIN_SECONDS <= shot.seconds <= SHOT_MAX_SECONDS:
            raise ModelRetry(
                f"镜头组 {shot.index} 的 seconds 是 {shot.seconds}，只收 "
                f"{SHOT_MIN_SECONDS}-{SHOT_MAX_SECONDS}；重新切分这一组再交付。"
            )
        if not shot.image_urls:
            raise ModelRetry(f"镜头组 {shot.index} 的 image_urls 为空；每组至少要有一张镜头帧。")
        unknown = [url for url in shot.image_urls if url not in known]
        if unknown:
            raise ModelRetry(
                f"镜头组 {shot.index} 里有 {len(unknown)} 个地址不是 generate_shot_frames "
                f"生成出来的镜头帧。逐字抄工具返回值；上下文里翻不到就用 read_file 读 "
                f"{GRID_RECORDS_DIR}/ 下的版记录取回来。"
            )
        highest = max((int(number) for number in _IMAGE_REF.findall(prompt)), default=0)
        if highest > len(shot.image_urls):
            raise ModelRetry(
                f"镜头组 {shot.index} 的 prompt 写到了 @Image{highest}，但这一组只有 "
                f"{len(shot.image_urls)} 张镜头帧。"
            )
        rows.append(
            {
                "index": shot.index,
                "prompt": prompt,
                "seconds": shot.seconds,
                "imageUrls": list(shot.image_urls),
            }
        )
    return rows


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


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def shot_video_capability(
    *,
    space: FileSpace,
    generations: ImageGenerations,
    objects: PublicObjectWriter,
    paths: ShotVideoPaths,
    understanding: VideoUnderstanding,
    client: httpx.AsyncClient,
    policy: GenerationPolicy | None = None,
) -> ShotVideo[Any]:
    """造一个镜头素材能力。组合根用这个，不直接碰 dataclass 的字段顺序。"""

    return ShotVideo[Any](
        space=space,
        generations=generations,
        objects=objects,
        paths=paths,
        understanding=understanding,
        client=client,
        policy=policy if policy is not None else GenerationPolicy(),
    )


__all__ = [
    "ANCHOR_ASPECT",
    "ANCHOR_RECORDS_DIR",
    "CAPABILITY_ID",
    "EXTRACTION_PATH",
    "GRID_RECORDS_DIR",
    "GRID_RESOLUTION",
    "SHOTS_PATH",
    "SHOT_MAX_SECONDS",
    "SHOT_MIN_SECONDS",
    "FrameRequest",
    "GenerationPolicy",
    "ShotVideo",
    "ShotVideoToolset",
    "VideoShotRequest",
    "shot_video_capability",
    "video_doc_path",
]
