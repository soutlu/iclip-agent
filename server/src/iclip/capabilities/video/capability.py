"""视频能力：拆解参考视频，交付镜头组 prompt 表。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Annotated, Any, ClassVar, Final

from pydantic_ai import ModelRetry
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import ToolReturn
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip.capabilities.shot_document import SHOTS_PATH, VideoShotRequest, deliver_shots
from iclip.capabilities.video_understanding import (
    VideoUnderstanding,
    VideoUnderstandingError,
    video_doc_path,
)
from iclip.common.tool_args import JsonText
from iclip.harness.materials import require_http, require_material
from iclip.platform.file_store.store import FileSpace, FileStore, QuotaExceeded
from iclip.platform.material_ledger.store import MaterialLedger
from iclip.platform.transcript.display import DisplayFn, GenericDisplay, url_filename

CAPABILITY_ID: Final = "video"


@dataclass
class Video(AbstractCapability[AgentDepsT]):
    """拆解参考视频与交付镜头组 prompt 表。"""

    REQUIRES: ClassVar[tuple[str, ...]] = ("workspace",)
    """写下的文件经 workspace 的文件工具读取。"""

    space: FileSpace
    """与工作区能力相同的 FileSpace。"""

    ledger: MaterialLedger
    """素材来源台账，供工具输入验证使用。"""

    understanding: VideoUnderstanding

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> VideoToolset[AgentDepsT]:
        return VideoToolset(self)

    def display_table(self) -> Mapping[str, DisplayFn]:
        """供组合根合并的工具卡声明。"""

        return {
            "video_parser": lambda args: GenericDisplay(
                summary="拆解视频", detail=_video_name(args)
            ),
            "write_video_shots": lambda _args: GenericDisplay(
                summary="保存分镜", detail=SHOTS_PATH
            ),
        }

    @classmethod
    def get_serialization_name(cls) -> str | None:
        return None


class VideoToolset(FunctionToolset[AgentDepsT]):
    """拆解与交付两件工具；参数的范围规则挂在登记处的验证器上。"""

    def __init__(self, capability: Video[AgentDepsT]) -> None:
        super().__init__(id=capability.id)
        self._cap = capability
        self.add_tool(
            Tool(
                self.video_parser,
                name="video_parser",
                args_validator=self._validate_video_url,
            )
        )
        self.add_tool(
            Tool(
                self.write_video_shots,
                name="write_video_shots",
                args_validator=self._validate_shot_delivery,
            )
        )

    async def video_parser(self, ctx: RunContext[AgentDepsT], video_url: str) -> str:
        """拆解参考视频，把拆解内容写进文件，返回它的路径。

        Args:
            video_url: 参考视频地址。
        """

        files, namespace = self._workspace(ctx)
        path = video_doc_path(video_url)
        try:
            content = await self._cap.understanding.parse(video_url)
        except VideoUnderstandingError as exc:
            raise ModelRetry(f"这段视频没拆解成功：{exc}") from exc
        try:
            await files.write(namespace, path, content)
        except QuotaExceeded as exc:
            raise ModelRetry(f"工作区写不下 {path}：{exc} 用 delete_file 清掉不用的文件。") from exc
        return f"视频解析完毕，文档在 {path}。"

    async def write_video_shots(
        self,
        ctx: RunContext[AgentDepsT],
        aspect_ratio: str,
        shots: Annotated[list[VideoShotRequest], JsonText],
    ) -> ToolReturn[str]:
        """提交镜头组 prompt 表；每次提交全部镜头组，替换已有的。

        Args:
            aspect_ratio: 目标画幅，如 ``9:16``。
            shots: 按顺序排列的全部镜头组；以 JSON 数组传入，不要整体序列化成字符串。
        """

        files, namespace = self._workspace(ctx)
        return await deliver_shots(files, namespace, aspect_ratio=aspect_ratio, shots=shots)

    async def _validate_video_url(self, ctx: RunContext[Any], video_url: str) -> None:
        """视频地址须是本对话已登记的视频素材。"""

        require_http(video_url, what="视频地址")
        await require_material(
            self._cap.ledger,
            self._cap.space.resolve(ctx),
            video_url,
            kind="video",
            what="视频地址",
        )

    async def _validate_shot_delivery(
        self, ctx: RunContext[Any], aspect_ratio: str, shots: list[VideoShotRequest]
    ) -> None:
        """镜头帧地址须是本对话已登记的图片素材；表的形状由工具体校验。"""

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
                )

    def _workspace(self, ctx: RunContext[AgentDepsT]) -> tuple[FileStore, str]:
        """这次运行的文件存储与命名空间。"""

        return self._cap.space.store, self._cap.space.resolve(ctx)


def _video_name(args: Any) -> str | None:
    """视频工具卡展示原素材文件名。"""

    url = args.get("video_url") if isinstance(args, dict) else None
    return url_filename(url) if isinstance(url, str) else None


__all__ = ["CAPABILITY_ID", "Video", "VideoToolset"]
