"""镜头素材工具注册、输入来源校验与工作区编排。"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, Final

import structlog
from pydantic_ai import ModelRetry, ToolFailed
from pydantic_ai.messages import ToolReturn
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip.capabilities.shot_video.delivery import (
    SHOTS_PATH,
    FrameRequest,
    VideoShotRequest,
    build_video_shots_document,
    resolve_cells,
    resolve_requests,
)
from iclip.capabilities.shot_video.extraction import EXTRACTION_PATH, video_doc_path
from iclip.capabilities.shot_video.generation import (
    ANCHOR_ASPECT,
    GRID_RESOLUTION,
    IMAGE_MODEL,
    job_failure,
)
from iclip.capabilities.shot_video.ports import ImageRequest
from iclip.capabilities.shot_video.prompt import assemble_anchor_prompt, assemble_grid_prompt
from iclip.capabilities.shot_video.shots import CELL_ID_SHAPE, parse_cell_id
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.public import Principal
from iclip.harness.materials import require_http, require_material
from iclip.platform.file_store.store import FileStore, QuotaExceeded
from iclip.platform.material_ledger.store import Material
from iclip.platform.transcript.display import media_grid, tool_note

_logger = structlog.stdlib.get_logger(__name__)

if TYPE_CHECKING:
    from iclip.capabilities.shot_video.capability import ShotVideo

GRID_RECORDS_DIR: Final = "frames/grids"
GRID_RECORD_VERSION: Final = 1
ANCHOR_RECORDS_DIR: Final = "anchors"
ANCHOR_RECORD_VERSION: Final = 1

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
        # 工具集复用能力 id，供 durable execution 识别。
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
        """从参考视频抽帧，按结构层级组合成图片。

        Args:
            ctx: 框架给的运行上下文。
            video_url: 参考视频地址。
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
        # 台账只存板号与地址；板上有哪几个镜头按 rows 现算。命中复用时 rows 与建账时
        # 逐字相同（它是 extractionKey 的组成部分），两条路算出来一样。
        shots_of = {
            board["board"]: sorted({shot.shot_id for shot in rows[board["board"] - 1]})
            for board in boards
        }
        message = (
            f"取帧完成：共 {len(rows)} 个结构层级，组合成 {len(boards)} 组图片。"
            f"每组图中每张视频帧左上的标注即帧号（{CELL_ID_SHAPE}）。"
        )
        return ToolReturn(
            return_value={
                "message": message,
                "boards": [
                    {
                        "board": board["board"],
                        "shots": shots_of[board["board"]],
                        "url": board["url"],
                    }
                    for board in boards
                ],
            },
            metadata=media_grid(
                (
                    (
                        board["url"],
                        f"板 {board['board']} · {','.join(map(str, shots_of[board['board']]))}",
                    )
                    for board in boards
                ),
                note=f"{len(boards)} 板",
            ),
        )

    async def generate_shot_frames(
        self,
        ctx: RunContext[AgentDepsT],
        frames: list[FrameRequest],
        reference_images: list[str],
        global_reference: str,
        target_aspect: str,
    ) -> ToolReturn[dict[str, Any]]:
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
                model=IMAGE_MODEL,
                aspect_ratio=target_aspect,
                resolution=GRID_RESOLUTION,
                channel="dev",
                user_name=_user_name(ctx),
                reference_image_urls=references,
                conversation_id=_conversation_id(ctx),
            ),
        )
        if job.status != "completed" or not job.output_url:
            job_failure(job, message="镜头帧生成失败。")
        cut = await self._cap.generator.cut(
            job,
            object_keys=[
                self._cap.paths.shot_cell(job_id=job.job_id, cell_id=cell_id)
                for cell_id in cell_ids
            ],
            aspect=target_aspect,
            failure_message="镜头帧处理失败。",
        )
        frames_payload = [
            {"no": cell_id, "shot": parse_cell_id(cell_id)[0], "url": url}
            for cell_id, url in zip(cell_ids, cut.urls, strict=True)
        ]
        record_path = f"{GRID_RECORDS_DIR}/{job.job_id}.json"
        await self._publish(
            files,
            namespace,
            record_path=record_path,
            record={
                "gridRecordVersion": GRID_RECORD_VERSION,
                "jobId": str(job.job_id),
                "gridUrl": cut.grid_url,
                "targetAspect": target_aspect,
                "globalReference": global_reference,
                "referenceImages": list(references),
                "frames": [
                    {**frame, "prompt": prompt}
                    for frame, prompt in zip(frames_payload, prompts, strict=True)
                ],
                "createdAt": int(time.time()),
            },
            urls=[*cut.urls, cut.grid_url],
            failure_message="镜头帧处理失败。",
        )
        return ToolReturn(
            return_value={"frames": frames_payload, "record": record_path},
            metadata=media_grid(zip(cut.urls, cell_ids, strict=True)),
        )

    async def generate_anchor_sheet(
        self, ctx: RunContext[AgentDepsT], cells: list[str]
    ) -> ToolReturn[dict[str, Any]]:
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
                model=IMAGE_MODEL,
                prompt=assemble_anchor_prompt(cells=descriptions, target_aspect=ANCHOR_ASPECT),
                aspect_ratio=ANCHOR_ASPECT,
                resolution=GRID_RESOLUTION,
                channel="dev",
                user_name=_user_name(ctx),
                conversation_id=_conversation_id(ctx),
            ),
        )
        if job.status != "completed" or not job.output_url:
            job_failure(job, message="设定图生成失败。")
        cut = await self._cap.generator.cut(
            job,
            object_keys=[
                self._cap.paths.anchor_sheet(job_id=job.job_id, index=index)
                for index in range(1, len(descriptions) + 1)
            ],
            # 设定图不收缩到目标画幅，避免裁掉主体。
            aspect=None,
            failure_message="设定图处理失败。",
        )
        images = [{"index": index, "url": url} for index, url in enumerate(cut.urls, start=1)]
        record_path = f"{ANCHOR_RECORDS_DIR}/{job.job_id}.json"
        await self._publish(
            files,
            namespace,
            record_path=record_path,
            record={
                "anchorRecordVersion": ANCHOR_RECORD_VERSION,
                "jobId": str(job.job_id),
                "gridUrl": cut.grid_url,
                "sheetAspect": ANCHOR_ASPECT,
                "cells": [
                    {**image, "description": description}
                    for image, description in zip(images, descriptions, strict=True)
                ],
                "createdAt": int(time.time()),
            },
            urls=[*cut.urls, cut.grid_url],
            failure_message="设定图处理失败。",
        )
        return ToolReturn(
            return_value={
                "message": f"补拍完成 {len(images)} 格，版记录见 {record_path}。",
                "status": "done",
                "images": images,
                "record": record_path,
                "error": None,
            },
            metadata=media_grid(zip(cut.urls, descriptions, strict=True), note=f"{len(images)} 格"),
        )

    async def write_video_shots(
        self,
        ctx: RunContext[AgentDepsT],
        aspect_ratio: str,
        shots: list[VideoShotRequest],
    ) -> ToolReturn[dict[str, Any]]:
        """提交镜头组 prompt 表。

        参数说明：
        - aspect_ratio：目标画幅，例如 9:16。
        - shots：按顺序排列的全部镜头组。

        每个镜头组包含：
        - index：镜头组编号，从 1 连续编号。
        - prompt：本组的结构化提示词，包含：
          - global_settings：本组的全局设定。
          - timeline：按镜头顺序排列的时间线，每项包含：
            - timestamps：[开始秒数, 结束秒数]，每组第一镜从 0 开始，
              保留小数。结束时间须大于开始时间，各镜头时间段不得重叠。
            - prompt：该镜头的正文，保留对应位置的 @ImageN。
        - seconds：本组总时长，四舍五入到整数秒，范围 4–30 秒。
        - image_urls：本组的镜头帧 URL 列表，可为空；有图时 @ImageN
          对应列表中的第 N 张图，地址须已登记在本对话素材台账中。
          无图时传 []，global_settings 和各镜头正文中不得出现 @ImageN。

        每次提交全部镜头组，替换已有的镜头组表。
        任一镜头组不符合要求时，整次提交拒绝；修正后重新提交全部镜头组。
        """

        files, namespace = self._workspace(ctx)
        document = build_video_shots_document(aspect_ratio, shots)
        await self._write(
            files,
            namespace,
            SHOTS_PATH,
            document.model_dump_json(indent=2),
        )
        group_count = len(document.shots)
        shot_count = sum(len(shot.prompt.timeline) for shot in document.shots)
        seconds = sum(shot.seconds for shot in document.shots)
        return ToolReturn(
            return_value={
                "message": (
                    f"镜头组 prompt 表已交付到 {SHOTS_PATH}："
                    f"{group_count} 个镜头组，{shot_count} 个镜头，合计 {seconds} 秒。"
                ),
                "path": SHOTS_PATH,
            },
            metadata=tool_note(chip=f"{group_count} 组 · {shot_count} 镜 · {seconds} 秒"),
        )

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

    async def _publish(
        self,
        files: FileStore,
        namespace: str,
        *,
        record_path: str,
        record: dict[str, Any],
        urls: Sequence[str],
        failure_message: str,
    ) -> None:
        """落版记录并登记素材；登记失败不要求模型重新出图。"""

        try:
            await self._write(
                files, namespace, record_path, json.dumps(record, ensure_ascii=False, indent=2)
            )
            await self._record_images(namespace, urls)
        except ModelRetry as exc:
            _logger.warning("生成产物登记失败", record_path=record_path, reason=str(exc))
            raise ToolFailed(failure_message) from exc

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

    return _deps(ctx).principal


def _user_name(ctx: RunContext[AgentDepsT]) -> str:
    """这次运行替谁跑：随消息进来的归属标签，出图时发给上游落表。不看运行主体是谁。"""

    return _deps(ctx).user_name


def _deps(ctx: RunContext[AgentDepsT]) -> AgentRunDeps:
    deps = ctx.deps
    if not isinstance(deps, AgentRunDeps):
        raise RuntimeError(
            f"这次运行的 deps 是 {type(deps).__name__}，不是 AgentRunDeps——运行身份没有注入进来。"
        )
    return deps


__all__ = ["ShotVideoToolset"]
