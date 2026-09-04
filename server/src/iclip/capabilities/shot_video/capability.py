"""镜头素材能力的装配面：收哪些依赖、把五件工具挂上去、这几件工具的卡怎么画。

工具靠工作区里的几份文件接力：拆解文档（`video/<名>.md`）、取帧账本
（`frames/extraction.json`）、逐批版记录（`frames/grids/`、`anchors/`），终点是
`video_shot.json`。落在哪由构造时给进来的 `FileSpace` 决定，和工作区能力收的是同一
个——所以模型用 `read_file` / `edit_file` 看见的就是这几件工具写的那批文件，时间码写
坏了它自己就能修。本包不认识工作区能力。
"""

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
"""三件出图 / 拼板工具的结果用这个渲染器画，形状是 ``MediaGridItems``。"""


@dataclass
class ShotVideo(AbstractCapability[AgentDepsT]):
    """把五件工具挂到 agent 上。"""

    space: FileSpace
    """拆解文档、账本与镜头组产物落在哪。必须和工作区能力收的是同一个。

    「同一个」由组合根保证：这里只认平台层这一件东西，不认识工作区能力。两边要
    是各接各的，文档照写照读，只是模型的 ``read_file`` 看不见它——失效是静默的。
    """

    ledger: MaterialLedger
    """这段对话能用哪些地址。五件工具落下的地址往它上面记，收地址的三个验证器查它。"""

    extractor: FrameExtractor
    """拆片与取帧那一段。"""

    generator: FrameGenerator
    """出图与切格那一段。"""

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
        return ShotVideoToolset(self)

    def get_instructions(self) -> AgentInstructions[AgentDepsT] | None:
        # 不注入指令：这几件工具怎么接力是流程知识，归 skill（architecture.md §5）。
        return None

    def display_table(self) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        """这五件工具的卡怎么画、结果用哪个渲染器画。组合根装配期取一次，合进那份注册表。"""

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
    """造一个镜头素材能力：这里是把这堆服务装成两段流水的唯一一处。"""

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
