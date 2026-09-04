"""五件工具：docstring、登记时挂的范围规则，以及工具体那点编排。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from pydantic_ai import ModelRetry
from pydantic_ai.messages import ToolReturn
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip.capabilities.shot_video.delivery import (
    SHOTS_PATH,
    FrameRequest,
    VideoShotRequest,
    resolve_cells,
    resolve_requests,
    resolve_shots,
)
from iclip.capabilities.shot_video.extraction import EXTRACTION_PATH, video_doc_path
from iclip.capabilities.shot_video.generation import (
    ANCHOR_ASPECT,
    GRID_RECORDS_DIR,
    GRID_RESOLUTION,
    GridCut,
    job_failure,
)
from iclip.capabilities.shot_video.grid import GridError, parse_aspect
from iclip.capabilities.shot_video.ports import ImageRequest
from iclip.capabilities.shot_video.prompt import assemble_anchor_prompt, assemble_grid_prompt
from iclip.capabilities.shot_video.shots import CELL_ID_SHAPE
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.public import Principal
from iclip.harness.materials import require_http, require_material
from iclip.platform.file_store.store import FileStore, QuotaExceeded
from iclip.platform.material_ledger.store import Material
from iclip.platform.transcript.display import media_grid

if TYPE_CHECKING:
    from iclip.capabilities.shot_video.capability import ShotVideo

_RECORDED_AT = (
    f"本能力写下的地址也记在 {EXTRACTION_PATH} 与 {GRID_RECORDS_DIR}/ 下，用 read_file 读回来再用。"
)
"""素材错误消息的收尾动作：本能力产出的地址都能从工作区里翻回来。"""


class ShotVideoToolset(FunctionToolset[AgentDepsT]):
    """五件工具。参数的范围规则挂在登记处的验证器上，工具体只做本职。

    五件都经 ``Tool`` 登记，不走 ``add_function``：后者的参数表由 pyright 从函数推，收 ``ctx``
    的工具会把 ``ctx`` 也算进参数表，于是任何一个签名正确的验证器都被判不兼容。
    代价是工具集级别的默认值（``strict`` / ``sequential`` / ``requires_approval`` / ``timeout``
    等）不再套到这五件上——这里只传 ``id``，所以现在没有差别；将来在 ``super().__init__``
    上加一个默认值，它对这五件会静默失效。
    """

    def __init__(self, capability: ShotVideo[AgentDepsT]) -> None:
        # id 跟着能力走，不各写一遍：durable execution 按 id 包工具集，两处对不上就包不住。
        super().__init__(id=capability.id)
        self._cap = capability
        self.add_tool(
            Tool(
                self.video_parser_md,
                name="video_parser_md",
                args_validator=self._validate_video_url,
            )
        )
        self.add_tool(
            Tool(
                self.plan_shot_frames,
                name="plan_shot_frames",
                args_validator=self._validate_video_url,
            )
        )
        self.add_tool(
            Tool(
                self.generate_shot_frames,
                name="generate_shot_frames",
                args_validator=self._validate_frame_generation,
            )
        )
        self.add_tool(Tool(self.generate_anchor_sheet, name="generate_anchor_sheet"))
        self.add_tool(
            Tool(
                self.write_video_shots,
                name="write_video_shots",
                args_validator=self._validate_shot_delivery,
            )
        )

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
        content = await self._cap.extractor.parse(video_url)
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
        rows = await self._cap.extractor.shot_rows(files, namespace, doc_path)
        document, reused = await self._cap.extractor.ledger(
            files, namespace, video_url=video_url, rows=rows
        )
        if not reused:
            await self._write(
                files,
                namespace,
                EXTRACTION_PATH,
                json.dumps(document, ensure_ascii=False, indent=2),
            )

        boards = document["boards"]
        await self._record_images(namespace, [board["url"] for board in boards])
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
            metadata=media_grid(
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
        document = await self._cap.extractor.load(files, namespace, expected_key=None)
        if document is None:
            raise ModelRetry("取帧账本不存在或版本不兼容，先调用 plan_shot_frames。")
        cell_ids, prompts = resolve_requests(frames)
        references = tuple(reference_images)
        try:
            prompt = assemble_grid_prompt(
                global_reference=global_reference,
                visual_prompts=prompts,
                target_aspect=target_aspect,
            )
        except ValueError as exc:
            raise ModelRetry(str(exc)) from exc

        job = await self._cap.generator.generate(
            principal,
            ImageRequest(
                prompt=prompt,
                aspect_ratio=target_aspect,
                resolution=GRID_RESOLUTION,
                channel="dev",
                reference_image_urls=references,
                conversation_id=_conversation_id(ctx),
            ),
        )
        if job.status != "completed" or not job.output_url:
            return job_failure(job)
        cut = await self._cap.generator.collect_frames(
            job,
            cell_ids=cell_ids,
            prompts=prompts,
            references=references,
            global_reference=global_reference,
            target_aspect=target_aspect,
        )
        return await self._deliver(files, namespace, cut)

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
        descriptions = resolve_cells(cells)
        job = await self._cap.generator.generate(
            principal,
            ImageRequest(
                prompt=assemble_anchor_prompt(cells=descriptions, target_aspect=ANCHOR_ASPECT),
                aspect_ratio=ANCHOR_ASPECT,
                resolution=GRID_RESOLUTION,
                channel="dev",
                conversation_id=_conversation_id(ctx),
            ),
        )
        if job.status != "completed" or not job.output_url:
            return job_failure(job, items_key="images")
        cut = await self._cap.generator.collect_anchors(job, descriptions=descriptions)
        return await self._deliver(files, namespace, cut)

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
        - `image_urls` 只收这段对话里出现过的地址；上下文里翻不到时用 `read_file` 读
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
        rows = resolve_shots(shots)
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

    async def _validate_video_url(self, ctx: RunContext[Any], video_url: str) -> None:
        """拆片与取帧收的视频地址。参数表与这两件工具逐字一致，官方按它调。"""

        require_http(video_url, what="视频地址")
        await require_material(
            self._cap.ledger,
            self._cap.space.resolve(ctx),
            video_url,
            kind="video",
            what="视频地址",
            recorded_at=_RECORDED_AT,
        )

    async def _validate_frame_generation(
        self,
        ctx: RunContext[Any],
        frames: list[FrameRequest],
        reference_images: list[str],
        global_reference: str,
        target_aspect: str,
    ) -> None:
        """出图收的参考图地址。

        ``frames`` 与画幅的规则要先读工作区里的账本，不是纯参数规则，留在工具体里；这几个参数在
        这里照收不看——参数表必须与工具逐字一致。
        """

        _ = (frames, global_reference, target_aspect)
        namespace = self._cap.space.resolve(ctx)
        for url in reference_images:
            require_http(url, what="参考图地址")
            await require_material(
                self._cap.ledger,
                namespace,
                url,
                kind="image",
                what="参考图地址",
                recorded_at=_RECORDED_AT,
            )

    async def _validate_shot_delivery(
        self, ctx: RunContext[Any], aspect_ratio: str, shots: list[VideoShotRequest]
    ) -> None:
        """交付收的镜头帧地址。参数表与工具逐字一致，官方按它调。

        只判地址来源；形状（编号、秒数、``@ImageN``）要先看整份表才判得了，留在工具体里。
        """

        _ = aspect_ratio
        namespace = self._cap.space.resolve(ctx)
        for shot in shots:
            for url in shot.image_urls:
                require_http(url, what="镜头帧地址")
                await require_material(
                    self._cap.ledger,
                    namespace,
                    url,
                    kind="image",
                    what="镜头帧地址",
                    recorded_at=_RECORDED_AT,
                )

    async def _deliver(
        self, files: FileStore, namespace: str, cut: GridCut | dict[str, Any]
    ) -> ToolReturn[dict[str, Any]] | dict[str, Any]:
        """切格没成就把失败返回原样交出去；成了就落版记录，再拼上给人看的缩略图墙。"""

        if not isinstance(cut, GridCut):
            return cut
        await self._write(
            files,
            namespace,
            cut.record_path,
            json.dumps(cut.record, ensure_ascii=False, indent=2),
        )
        await self._record_images(namespace, [*cut.urls, cut.grid_url])
        return ToolReturn(
            return_value=cut.payload,
            metadata=media_grid(zip(cut.urls, cut.captions, strict=True)),
        )

    async def _record_images(self, namespace: str, urls: Sequence[str]) -> None:
        """把本能力落下的图片地址记进台账，模型下一步才交得回来。"""

        await self._cap.ledger.record(namespace, [Material(url=url, kind="image") for url in urls])

    async def _write(self, files: FileStore, namespace: str, path: str, content: str) -> None:
        try:
            await files.write(namespace, path, content)
        except QuotaExceeded as exc:
            raise ModelRetry(f"工作区写不下 {path}：{exc} 用 delete_file 清掉不用的文件。") from exc

    def _workspace(self, ctx: RunContext[AgentDepsT]) -> tuple[FileStore, str]:
        """这次运行的文件存储与命名空间。命名空间算不出来就让它抛，不退回公共的。"""

        return self._cap.space.store, self._cap.space.resolve(ctx)


def _conversation_id(ctx: RunContext[AgentDepsT]) -> str | None:
    """这次运行跑在哪段对话里，出图记录按它归档。

    值是客户端给的（见 ``AgentRunDeps``），所以形状不对就当作没有——归档少一条好过让
    一次已经算得出图的调用死在一个 id 上。
    """

    deps = ctx.deps
    if not isinstance(deps, AgentRunDeps):
        return None
    try:
        uuid.UUID(deps.conversation_id)
    except ValueError:
        return None
    return deps.conversation_id


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


__all__ = ["ShotVideoToolset"]
