"""完全复刻能力：拆解参考视频，交付同结构的镜头组 prompt 表，不出图也不抽帧。

镜头组表的结构与规则见 [shot_document](../shot_document.py)，与分镜流共用。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Annotated, Any, ClassVar, Final

from pydantic import Field
from pydantic_ai import ModelRetry
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import ToolReturn
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip.capabilities.shot_document import (
    MAX_REFERENCE_IMAGES,
    SHOTS_PATH,
    VideoShotRequest,
    deliver_shots,
)
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

CAPABILITY_ID: Final = "exact_replica"


ReferenceImageUrls = Annotated[
    list[str],
    Field(
        min_length=1,
        max_length=MAX_REFERENCE_IMAGES,
        description="本组参考图片地址，按 @Image1..N 顺序排列。",
    ),
]
"""完全复刻提交时必须自带 1–30 张参考图；文件写回使用共用文档规则。"""


class ReplicaShotRequest(VideoShotRequest):
    """不出图流程的一组镜头，使用 1–30 张参考图片。"""

    image_urls: ReferenceImageUrls


@dataclass
class ExactReplica(AbstractCapability[AgentDepsT]):
    """共享工作区中的参考视频解析与镜头组 prompt 交付。"""

    REQUIRES: ClassVar[tuple[str, ...]] = ("workspace",)
    """交付的文件要靠 workspace 的文件工具让模型读到，装配期一并校验。"""

    space: FileSpace
    ledger: MaterialLedger
    understanding: VideoUnderstanding
    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> ExactReplicaToolset[AgentDepsT]:
        return ExactReplicaToolset(self)

    def display_table(self) -> Mapping[str, DisplayFn]:
        return {
            "parse_reference_video": lambda args: GenericDisplay(
                summary="拆解视频", detail=_video_name(args)
            ),
            "write_replica_shots": lambda _args: GenericDisplay(
                summary="保存分镜", detail=SHOTS_PATH
            ),
        }

    @classmethod
    def get_serialization_name(cls) -> str | None:
        return None


class ExactReplicaToolset(FunctionToolset[AgentDepsT]):
    """两件文档工具，参数校验先于解析和写入。"""

    def __init__(self, capability: ExactReplica[AgentDepsT]) -> None:
        super().__init__(id=capability.id)
        self._space = capability.space
        self._ledger = capability.ledger
        self._understanding = capability.understanding
        self.add_tool(
            Tool(
                self.parse_reference_video,
                name="parse_reference_video",
                args_validator=self._validate_video_url,
            )
        )
        self.add_tool(
            Tool(
                self.write_replica_shots,
                name="write_replica_shots",
                args_validator=self._validate_shot_delivery,
            )
        )

    async def parse_reference_video(self, ctx: RunContext[AgentDepsT], video_url: str) -> str:
        """拆解参考视频，把拆解内容写进文件，返回它的路径。

        Args:
            video_url: 参考视频地址。
        """

        files, namespace = self._workspace(ctx)
        path = video_doc_path(video_url)
        try:
            content = await self._understanding.parse(video_url)
        except VideoUnderstandingError as exc:
            raise ModelRetry(f"这段视频没拆解成功：{exc}") from exc
        try:
            await files.write(namespace, path, content)
        except QuotaExceeded as exc:
            raise ModelRetry(f"工作区写不下 {path}：{exc} 用 delete_file 清掉不用的文件。") from exc
        return f"视频解析完毕，文档在 {path}。"

    async def write_replica_shots(
        self,
        ctx: RunContext[AgentDepsT],
        aspect_ratio: str,
        shots: Annotated[list[ReplicaShotRequest], JsonText],
    ) -> ToolReturn[str]:
        """提交镜头组 prompt 表；每次提交全部镜头组，替换已有的。

        Args:
            aspect_ratio: 目标画幅，如 ``9:16``。
            shots: 按顺序排列的全部镜头组；以 JSON 数组传入，不要整体序列化成字符串。
        """

        files, namespace = self._workspace(ctx)
        return await deliver_shots(files, namespace, aspect_ratio=aspect_ratio, shots=shots)

    async def _validate_shot_delivery(
        self, ctx: RunContext[Any], aspect_ratio: str, shots: list[ReplicaShotRequest]
    ) -> None:
        """交付收的参考图地址。参数表与工具逐字一致，官方按它调。

        只判地址来源；形状（编号、秒数、``@ImageN``）要先看整份表才判得了，留在工具体里。
        """

        _ = aspect_ratio
        namespace = self._space.resolve(ctx)
        for shot in shots:
            for url in shot.image_urls:
                require_http(url, what="参考图地址")
                await require_material(
                    self._ledger,
                    namespace,
                    url,
                    kind="image",
                    what="参考图地址",
                )

    async def _validate_video_url(self, ctx: RunContext[Any], video_url: str) -> None:
        """解析前验证参考视频属于当前对话。"""

        require_http(video_url, what="视频地址")
        await require_material(
            self._ledger,
            self._space.resolve(ctx),
            video_url,
            kind="video",
            what="视频地址",
        )

    def _workspace(self, ctx: RunContext[AgentDepsT]) -> tuple[FileStore, str]:
        """这次运行的文件存储与命名空间。命名空间算不出来就让它抛，不退回公共的。"""

        return self._space.store, self._space.resolve(ctx)


def _video_name(args: Any) -> str | None:
    """视频工具卡展示原素材文件名。"""

    url = args.get("video_url") if isinstance(args, dict) else None
    return url_filename(url) if isinstance(url, str) else None


__all__ = [
    "MAX_REFERENCE_IMAGES",
    "SHOTS_PATH",
    "ExactReplica",
    "ExactReplicaToolset",
    "ReplicaShotRequest",
]
