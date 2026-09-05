"""镜头素材能力装配。工具通过工作区文档与台账协作，最终交付 video_shot.json。
与工作区能力共用 FileSpace，确保写入产物可由文件工具读取和编辑。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final

import httpx
from pydantic_ai.agent.abstract import AgentInstructions
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.tools import AgentDepsT
from pydantic_ai.toolsets import AgentToolset

from iclip.capabilities.shot_video.delivery import SHOTS_PATH
from iclip.capabilities.shot_video.extraction import FrameExtractor
from iclip.capabilities.shot_video.generation import FrameGenerator, GenerationPolicy
from iclip.capabilities.shot_video.ports import (
    ImageGenerations,
    PublicObjectWriter,
    ShotVideoPaths,
    VideoUnderstanding,
)
from iclip.capabilities.shot_video.toolset import ShotVideoToolset
from iclip.platform.file_store.store import FileSpace
from iclip.platform.material_ledger.store import MaterialLedger
from iclip.platform.transcript.display import (
    DisplayFn,
    FileIoDisplay,
    GenericDisplay,
    ToolDisplay,
    ToolDisplayEntry,
)

CAPABILITY_ID: Final = "shot_video"

_MEDIA_GRID_VIEW: Final = "media_grid"
"""媒体生成与预览工具共用的 MediaGridItems 渲染器。"""


@dataclass
class ShotVideo(AbstractCapability[AgentDepsT]):
    """镜头素材工具集。"""

    space: FileSpace
    """产物存储与命名空间，必须由组合根提供与工作区能力相同的 FileSpace。"""

    ledger: MaterialLedger
    """素材来源台账，记录产物地址并供工具输入验证使用。"""

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

        return {
            "video_parser_md": lambda _args: GenericDisplay(summary="拆解参考片"),
            "plan_shot_frames": ToolDisplayEntry(
                draw=lambda _args: GenericDisplay(summary="按镜头取帧拼板"), view=_MEDIA_GRID_VIEW
            ),
            "generate_shot_frames": ToolDisplayEntry(draw=_frames_display, view=_MEDIA_GRID_VIEW),
            "generate_anchor_sheet": ToolDisplayEntry(
                draw=lambda _args: GenericDisplay(summary="补拍设定图"), view=_MEDIA_GRID_VIEW
            ),
            "write_video_shots": lambda _args: FileIoDisplay(operation="write", path=SHOTS_PATH),
        }

    @classmethod
    def get_serialization_name(cls) -> str | None:
        # 依赖都是运行期对象（服务、连接池），从 YAML spec 里造不出来。
        return None


def _frames_display(args: Any) -> ToolDisplay:
    frames = args.get("frames") if isinstance(args, dict) else None
    return GenericDisplay(summary=f"出图 {len(frames)} 帧" if isinstance(frames, list) else "出图")


def shot_video_capability(
    *,
    space: FileSpace,
    ledger: MaterialLedger,
    generations: ImageGenerations,
    objects: PublicObjectWriter,
    paths: ShotVideoPaths,
    understanding: VideoUnderstanding,
    client: httpx.AsyncClient,
    policy: GenerationPolicy | None = None,
) -> ShotVideo[Any]:
    """装配素材提取与生成服务。"""

    return ShotVideo[Any](
        space=space,
        ledger=ledger,
        extractor=FrameExtractor(
            understanding=understanding, client=client, paths=paths, objects=objects
        ),
        generator=FrameGenerator(
            generations=generations,
            objects=objects,
            paths=paths,
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
