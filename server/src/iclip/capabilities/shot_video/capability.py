"""镜头素材能力装配。工具通过工作区文档与台账协作，最终交付 video_shot.json。
与工作区能力共用 FileSpace，确保写入产物可由文件工具读取和编辑。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, ClassVar, Final

import httpx
from pydantic_ai.agent.abstract import AgentInstructions
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.tools import AgentDepsT
from pydantic_ai.toolsets import AgentToolset

from iclip.capabilities.shot_document import SHOTS_PATH
from iclip.capabilities.shot_video.extraction import FrameExtractor
from iclip.capabilities.shot_video.generation import IMAGE_MODEL, FrameGenerator, GenerationPolicy
from iclip.capabilities.shot_video.ports import (
    ImageGenerations,
    PublicObjectWriter,
    ShotVideoPaths,
)
from iclip.capabilities.shot_video.toolset import ShotVideoToolset
from iclip.capabilities.video_understanding import VideoUnderstanding
from iclip.platform.file_store.store import FileSpace
from iclip.platform.material_ledger.store import MaterialLedger
from iclip.platform.transcript.display import (
    MEDIA_GRID_VIEW,
    DisplayFn,
    GenericDisplay,
    ToolDisplay,
    ToolDisplayEntry,
    url_filename,
)

CAPABILITY_ID: Final = "shot_video"


@dataclass
class ShotVideo(AbstractCapability[AgentDepsT]):
    """镜头素材工具集。"""

    REQUIRES: ClassVar[tuple[str, ...]] = ("workspace",)
    """产物与台账要靠 workspace 的文件工具让模型读到，装配期一并校验。"""

    space: FileSpace
    """产物存储与命名空间，必须由组合根提供与工作区能力相同的 FileSpace。"""

    ledger: MaterialLedger
    """素材来源台账，记录产物地址并供工具输入验证使用。"""

    paths: ShotVideoPaths
    """产物对象路径布局；出图工具按它给每一格定键。"""

    extractor: FrameExtractor

    generator: FrameGenerator

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
        return ShotVideoToolset(self)

    def get_instructions(self) -> AgentInstructions[AgentDepsT] | None:
        # 不注入指令：这几件工具怎么接力是流程知识，归 skill（architecture.md §5）。
        return None

    def display_table(self) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        """供组合根合并的工具卡与结果渲染声明。"""

        # 标题写法见 docs/tool-design.md §4：书面动宾短语，数字进 metadata 角标。
        return {
            "video_parser": lambda args: GenericDisplay(
                summary="拆解视频", detail=_video_name(args)
            ),
            "plan_shot_frames": ToolDisplayEntry(
                draw=lambda args: GenericDisplay(summary="提取候选帧", detail=_video_name(args)),
                view=MEDIA_GRID_VIEW,
            ),
            "generate_shot_frames": ToolDisplayEntry(draw=_frames_display, view=MEDIA_GRID_VIEW),
            "generate_anchor_sheet": ToolDisplayEntry(
                draw=lambda _args: GenericDisplay(summary="生成设定图"), view=MEDIA_GRID_VIEW
            ),
            "write_video_shots": lambda _args: GenericDisplay(
                summary="保存分镜", detail=SHOTS_PATH
            ),
        }

    @classmethod
    def get_serialization_name(cls) -> str | None:
        # 依赖都是运行期对象（服务、连接池），从 YAML spec 里造不出来。
        return None


def _video_name(args: Any) -> str | None:
    url = args.get("video_url") if isinstance(args, dict) else None
    return url_filename(url) if isinstance(url, str) else None


def _frames_display(args: Any) -> ToolDisplay:
    """主语是这批帧所属的镜头号；帧号形如 S8-1，镜头号取 S 后面的数字。"""

    frames = args.get("frames") if isinstance(args, dict) else None
    shots: list[int] = []
    for frame in frames if isinstance(frames, list) else []:
        no = frame.get("no") if isinstance(frame, dict) else None
        head = no.split("-", 1)[0].lstrip("S") if isinstance(no, str) else ""
        if head.isdigit() and int(head) not in shots:
            shots.append(int(head))
    detail = f"镜头 {'、'.join(map(str, sorted(shots)))}" if shots else None
    return GenericDisplay(summary="生成画面", detail=detail)


def shot_video_capability(
    *,
    space: FileSpace,
    ledger: MaterialLedger,
    generations: ImageGenerations,
    objects: PublicObjectWriter,
    paths: ShotVideoPaths,
    understanding: VideoUnderstanding,
    client: httpx.AsyncClient,
    image_models: frozenset[str],
    policy: GenerationPolicy | None = None,
) -> ShotVideo[Any]:
    """装配素材提取与生成服务。缺少出图要用的模型即拒绝装配。"""

    if IMAGE_MODEL not in image_models:
        # 出图把用哪家钉在代码里，配置没接这家就是每次出图都失败，起不来比跑起来好。
        raise RuntimeError(
            f"出图工具要 {IMAGE_MODEL}，但 media_generation.image.models 里没有它；"
            f"已接入的是 {'、'.join(sorted(image_models)) or '（空）'}"
        )
    return ShotVideo[Any](
        space=space,
        ledger=ledger,
        paths=paths,
        extractor=FrameExtractor(
            understanding=understanding, client=client, paths=paths, objects=objects
        ),
        generator=FrameGenerator(
            generations=generations,
            objects=objects,
            client=client,
            policy=policy if policy is not None else GenerationPolicy(),
        ),
    )


__all__ = [
    "CAPABILITY_ID",
    "GenerationPolicy",
    "ShotVideo",
    "shot_video_capability",
]
