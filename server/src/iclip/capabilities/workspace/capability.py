"""工作区能力，通过注入的 FileSpace 提供持久化文件工具。

FileSpace 包含运行对象，无法由 YAML spec 构造，因此禁用序列化名称。
文件清单由 list_files 按需读取，不逐轮注入模型上下文。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Final, Literal

from pydantic import BaseModel, Field
from pydantic_ai import ModelRetry
from pydantic_ai.agent.abstract import AgentInstructions
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import ImageUrl, ToolReturn
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import AgentToolset, FunctionToolset

from iclip.capabilities.workspace.ports import ImageInfo, MediaProbe, MediaProbeFailed
from iclip.harness.materials import require_http, require_material
from iclip.harness.media import (
    IMAGE_CONTEXT_MAX_EDGE,
    cropped_image_url,
    media_tag_close,
    media_tag_open,
    resized_image_url,
)
from iclip.platform.file_store.store import (
    FileEntry,
    FileSpace,
    InvalidContent,
    InvalidPath,
    QuotaExceeded,
    VersionConflict,
    normalize_path,
)
from iclip.platform.material_ledger.store import MaterialLedger
from iclip.platform.transcript.display import (
    DisplayFn,
    FileIoDisplay,
    GenericDisplay,
    SearchDisplay,
    ToolDisplay,
    ToolDisplayEntry,
    UrlFetchDisplay,
    media_grid,
)

CAPABILITY_ID: Final = "workspace"
"""能力与工具集共用的稳定 id，用于识别 for_run 克隆及 durable execution 工具集。"""

MAX_READ_LINES: Final = 400
MAX_SEARCH_RESULTS: Final = 50

FULL_RESOLUTION_MAX_BYTES: Final = 10 * 1024 * 1024
"""原分辨率单图大小上限，超限时要求使用 region 分块读取。"""

_MEDIA_GRID_VIEW: Final = "media_grid"
"""读图结果的 MediaGridItems 渲染器。"""

_RECORDED_AT: Final = "工具结果里返回的地址记在它写下的账本或版记录里，用 read_file 读回来再用。"
"""素材来源错误的恢复指引。"""

_GUIDANCE = "这段对话有一个持久的工作目录，你和你派出去的下属共用同一个根，所有路径都相对它。"
"""仅说明目录用途，工具用法由各工具的提示与参数描述定义，避免重复注入。"""


@dataclass
class Workspace(AbstractCapability[AgentDepsT]):
    """把工作区工具集挂到 agent 上。"""

    space: FileSpace
    """存储后端与运行命名空间解析规则。解析失败必须终止运行，禁止使用公共命名空间。"""

    probe: MediaProbe
    """读取原图尺寸、大小与格式的外部协议。"""

    ledger: MaterialLedger
    """校验图片地址来源的对话素材台账。"""

    # 保留父类 id 的 kw_only 属性，避免默认字段先于必需位置字段。
    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    _scope: str | None = field(default=None, init=False, repr=False, compare=False)

    async def for_run(self, ctx: RunContext[AgentDepsT]) -> Workspace[AgentDepsT]:
        """克隆能力并解析命名空间，在首次模型请求前暴露身份或装配错误。"""

        clone = replace(self)
        clone._scope = clone._resolve_scope(ctx)
        return clone

    def resolve_scope(self, ctx: RunContext[AgentDepsT]) -> str:

        if self._scope is not None:
            return self._scope
        return self._resolve_scope(ctx)

    def _resolve_scope(self, ctx: RunContext[AgentDepsT]) -> str:
        return self.space.resolve(ctx)

    def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
        return WorkspaceToolset(self)

    def get_instructions(self) -> AgentInstructions[AgentDepsT] | None:
        return _GUIDANCE

    def display_table(self) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        """供组合根合并的工具卡与结果渲染声明。"""

        return {
            "read_file": ToolDisplayEntry(
                draw=lambda args: _file_io("read", _text(args, "path")), view="file_content"
            ),
            "write_file": lambda args: _file_io("write", _text(args, "path")),
            "edit_file": lambda args: _file_io("edit", _text(args, "path")),
            # 列目录按 glob 画；协议的 operation 联合里没有「删」，删文件走 generic。
            "list_files": lambda args: _file_io("glob", _text(args, "prefix") or "/"),
            "delete_file": _delete_display,
            "search_files": ToolDisplayEntry(draw=_search_display, view="search_results"),
            "ReadMediaFile": ToolDisplayEntry(draw=_media_display, view=_MEDIA_GRID_VIEW),
        }

    @classmethod
    def get_serialization_name(cls) -> str | None:
        return None


def _text(args: Any, field_name: str) -> str | None:

    if isinstance(args, dict):
        value = args.get(field_name)
        if isinstance(value, str) and value:
            return value
    return None


def _file_io(
    operation: Literal["read", "write", "edit", "glob", "grep"], path: str | None
) -> ToolDisplay | None:
    return None if path is None else FileIoDisplay(operation=operation, path=path)


def _delete_display(args: Any) -> ToolDisplay | None:
    path = _text(args, "path")
    return None if path is None else GenericDisplay(summary=f"删除文件 {path}")


def _search_display(args: Any) -> ToolDisplay | None:
    query = _text(args, "query")
    return None if query is None else SearchDisplay(query=query)


def _media_display(args: Any) -> ToolDisplay | None:
    url = _text(args, "url")
    return None if url is None else UrlFetchDisplay(url=url)


def _bytes_label(size_bytes: int) -> str:

    mib = 1024 * 1024
    if size_bytes >= mib:
        return f"{size_bytes / mib:.1f} MB"
    return f"{size_bytes / 1024:.1f} KB"


def _checked(path: str) -> str:
    """将路径语法错误转换为 ModelRetry；存储边界仍独立校验外部输入。"""

    try:
        return normalize_path(path)
    except InvalidPath as exc:
        raise ModelRetry(str(exc)) from exc


class CropRegion(BaseModel):
    """原图像素坐标下的一块矩形。"""

    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(ge=1)
    height: int = Field(ge=1)


class WorkspaceToolset(FunctionToolset[AgentDepsT]):
    """工作区工具集，命名空间不由工具参数指定。

    读图通过 Tool 注册，避免 add_function 的类型推导将 ctx 计入参数验证器签名。"""

    def __init__(self, capability: Workspace[AgentDepsT]) -> None:
        super().__init__(id=CAPABILITY_ID)
        self._capability = capability
        self.add_function(self.read_file, name="read_file")
        self.add_function(self.write_file, name="write_file")
        self.add_function(self.edit_file, name="edit_file")
        self.add_function(self.delete_file, name="delete_file")
        self.add_function(self.list_files, name="list_files")
        self.add_function(self.search_files, name="search_files")
        self.add_tool(
            Tool(
                self.read_media_file,
                name="ReadMediaFile",
                args_validator=self._validate_image_url,
            )
        )

    async def _validate_image_url(
        self,
        ctx: RunContext[Any],
        url: str,
        region: CropRegion | None = None,
        full_resolution: bool = False,
    ) -> None:
        """工具参数验证器，签名须与 read_media_file 一致。"""

        _ = (region, full_resolution)
        require_http(url, what="图片地址")
        await require_material(
            self._capability.ledger,
            self._capability.resolve_scope(ctx),
            url,
            kind="image",
            what="图片地址",
            recorded_at=_RECORDED_AT,
        )

    async def read_file(
        self, ctx: RunContext[AgentDepsT], path: str, offset: int = 1, limit: int = MAX_READ_LINES
    ) -> str:
        """读一个工作区文件，返回带行号的内容。

        Args:
            ctx: 框架给的运行上下文。
            path: 文件路径，如 ``分镜/第一集.md``。
            offset: 从第几行开始读，1 起算。
            limit: 最多读多少行。
        """

        key = _checked(path)
        scope = self._capability.resolve_scope(ctx)
        stored = await self._capability.space.store.read(scope, key)
        if stored is None:
            raise ModelRetry(f"工作区里没有 {key!r}。用 list_files 看看有哪些文件。")
        if offset < 1:
            raise ModelRetry("offset 从 1 起算。")
        capped = min(limit, MAX_READ_LINES)
        lines = stored.content.splitlines()
        window = lines[offset - 1 : offset - 1 + capped]
        if not window:
            raise ModelRetry(f"{key!r} 只有 {len(lines)} 行，读不到第 {offset} 行。")
        numbered = "\n".join(f"{offset + index:>6}\t{line}" for index, line in enumerate(window))
        remaining = len(lines) - (offset - 1 + len(window))
        if remaining > 0:
            numbered += f"\n[还有 {remaining} 行没读，接着从第 {offset + len(window)} 行读]"
        return numbered

    async def write_file(self, ctx: RunContext[AgentDepsT], path: str, content: str) -> str:
        """写一个工作区文件，已存在就整份覆盖。

        覆盖就是覆盖：别人（或你自己上一轮）改过的内容会一起没掉。只改其中一
        段就用 ``edit_file``，那条路径带并发保护。只放文本，图片和音视频不要写
        进来。

        Args:
            ctx: 框架给的运行上下文。
            path: 文件路径，如 ``分镜/第一集.md``。
            content: 文件全文。
        """

        key = _checked(path)
        scope = self._capability.resolve_scope(ctx)
        entry = await self._write(scope, key, content)
        return f"已写入 {entry.path}（{entry.size_bytes} 字节）"

    async def edit_file(
        self, ctx: RunContext[AgentDepsT], path: str, old_text: str, new_text: str
    ) -> str:
        """把文件里的一段文本替换掉，``old_text`` 必须恰好出现一次。

        改一处就用它，别把整份稿子重写一遍。``old_text`` 要连标点和空白一起照
        抄；不唯一时把上下文多带几行进来。

        Args:
            ctx: 框架给的运行上下文。
            path: 文件路径，如 ``分镜/第一集.md``。
            old_text: 要被替换掉的原文，须与文件内容逐字符一致。
            new_text: 替换成什么。留空即删掉这一段。
        """

        key = _checked(path)
        if not old_text:
            raise ModelRetry("old_text 不能为空；要新建或整份覆盖就用 write_file。")
        scope = self._capability.resolve_scope(ctx)
        stored = await self._capability.space.store.read(scope, key)
        if stored is None:
            raise ModelRetry(f"工作区里没有 {key!r}。要新建就用 write_file。")
        occurrences = stored.content.count(old_text)
        if occurrences == 0:
            raise ModelRetry(
                f"{key!r} 里找不到这段原文。先用 read_file 看一眼实际内容再改（空白和标点要照抄）。"
            )
        if occurrences > 1:
            raise ModelRetry(
                f"这段原文在 {key!r} 里出现了 {occurrences} 次，不知道该改哪一处。"
                "把上下文多带几行进 old_text，让它唯一。"
            )
        # 按读取版本条件写入，防止并发覆盖；版本控制由工具内部处理。
        entry = await self._write(
            scope, key, stored.content.replace(old_text, new_text), expected_version=stored.version
        )
        return f"已改 {entry.path}（现在 {entry.size_bytes} 字节）"

    async def delete_file(self, ctx: RunContext[AgentDepsT], path: str) -> str:
        """删掉一个不再需要的工作区文件。

        Args:
            ctx: 框架给的运行上下文。
            path: 文件路径。
        """

        key = _checked(path)
        scope = self._capability.resolve_scope(ctx)
        if not await self._capability.space.store.delete(scope, key):
            raise ModelRetry(f"工作区里没有 {key!r}，无从删除。")
        return f"已删除 {key}"

    async def list_files(self, ctx: RunContext[AgentDepsT], prefix: str = "") -> str:
        """列出工作区里的文件。

        接手一段对话先用它看看已经攒了什么，别从零重来。

        Args:
            ctx: 框架给的运行上下文。
            prefix: 只看某个目录下的，如 ``分镜``。留空即全部。
        """

        scope = self._capability.resolve_scope(ctx)
        entries = await self._entries(scope, prefix)
        if not entries:
            where = "工作区" if not prefix else f"{prefix!r} 下"
            return f"{where}还没有任何文件。"
        return "\n".join(f"{entry.path}\t{entry.size_bytes} 字节" for entry in entries)

    async def search_files(self, ctx: RunContext[AgentDepsT], query: str, limit: int = 20) -> str:
        """在工作区的文件内容里检索一个字符串，返回命中的行。

        大小写不敏感，按字面量匹配（不是正则）。同一个文件最多报前几处命中。

        Args:
            ctx: 框架给的运行上下文。
            query: 要找的文本。
            limit: 最多返回多少条命中。
        """

        if not query:
            raise ModelRetry("要检索的文本不能为空。")
        scope = self._capability.resolve_scope(ctx)
        result = await self._capability.space.store.search(
            scope, query, limit=min(limit, MAX_SEARCH_RESULTS)
        )
        if not result.matches:
            return f"工作区里没有包含 {query!r} 的内容。"
        lines = [f"{match.path}:{match.line}\t{match.snippet}" for match in result.matches]
        if result.truncated:
            lines.append("[命中较多，只报了一部分；把检索词写得更具体一些]")
        return "\n".join(lines)

    async def read_media_file(
        self,
        ctx: RunContext[AgentDepsT],
        url: str,
        region: CropRegion | None = None,
        full_resolution: bool = False,
    ) -> ToolReturn:
        """读取一张图片，原始内容以多模态形式附在工具结果中。

        - 本工具通常是你会希望并行使用的工具：需要看多张图时在同一次回复中发起多
          次调用，不要分多轮逐张读取。
        - 已读取且仍在上下文中的图片不要重复读取。
        - 本工具只读图片。视频信息读拆解文档，文本与产物文件用 `read_file`。
        - 默认降采样到长边 1024（原图长边本来不超过 1024 时原样附上）。要看清小字
          或细节，给 `region` 按原图像素坐标取一块看；`full_resolution` 只在必须看
          整幅原分辨率时给，常规读图不给。
        - `region` 与 `full_resolution` 不要同时给，同时给会被拒。
        - 原图超过 10 MB 时 `full_resolution` 会被拒，改用 `region` 分块看。
        - 结果开头一句报出原图宽高、格式、字节数与这次的交付方式。输出坐标一律按
          原图尺寸算，读的是 `region` 时再加上区域偏移。
        - 只接受这段对话里出现过的地址；自行构造的一律被拒。上下文里已经翻不到那
          个地址时，用 `read_file` 读回记着它的那份账本或版记录。

        Args:
            ctx: 框架给的运行上下文。
            url: 图片地址，逐字取自对话或本会话工具结果里的图片 URL，不要自行构造。
            region: 要看的那一块，x / y / width / height 按原图像素坐标给；越过右下
                边界的部分裁到边界为止。
            full_resolution: 整幅按原分辨率附上，不降采样。
        """

        if region is not None and full_resolution:
            raise ModelRetry(
                "region 与 full_resolution 二选一：看局部小字给 region，看整幅原分辨率给 "
                "full_resolution。去掉一个再调。"
            )
        try:
            info = await self._capability.probe.image_info(url)
        except MediaProbeFailed as exc:
            raise ModelRetry(f"这张图读不了（{exc}）；换一个对话里出现过的图片地址。") from exc
        # 使用 OSS 参数执行缩放裁切，模型下载交付地址；素材 tag 保留原图地址。
        try:
            delivered, clause, advice = self._deliver(
                url, info, region=region, full_resolution=full_resolution
            )
        except ValueError as exc:
            raise ModelRetry(f"这张图读不了（{exc}）") from exc
        summary = (
            f"原图 {info.width}×{info.height} 像素，{info.media_type}，"
            f"{_bytes_label(info.size_bytes)}；{clause}。{advice}"
        )
        # 直接返回多模态内容，保持在工具结果中；ToolReturn(content=...) 会追加用户消息。
        # tag 关联原图地址、摘要与像素，后续工具引用原图而非带裁切参数的交付地址。
        return ToolReturn(
            return_value=[
                media_tag_open("image", url),
                summary,
                ImageUrl(url=delivered, media_type=info.media_type),
                media_tag_close("image"),
            ],
            metadata=media_grid([(delivered, clause)]),
        )

    def _deliver(
        self, url: str, info: ImageInfo, *, region: CropRegion | None, full_resolution: bool
    ) -> tuple[str, str, str]:
        """选择图片交付地址，并生成交付方式与坐标说明。"""

        if region is not None:
            if region.x >= info.width or region.y >= info.height:
                raise ModelRetry(
                    f"region 的起点 ({region.x}, {region.y}) 落在原图之外：原图是 "
                    f"{info.width}×{info.height} 像素，按这个尺寸重算坐标再调。"
                )
            # OSS 会按图像边界截断裁切，返回实际区域尺寸。
            seen_width = min(region.width, info.width - region.x)
            seen_height = min(region.height, info.height - region.y)
            shrunk = max(seen_width, seen_height) > IMAGE_CONTEXT_MAX_EDGE
            delivered = cropped_image_url(
                url,
                x=region.x,
                y=region.y,
                width=region.width,
                height=region.height,
                max_edge=IMAGE_CONTEXT_MAX_EDGE if shrunk else None,
            )
            clause = f"当前显示区域 x={region.x}, y={region.y}, {seen_width}×{seen_height}"
            if shrunk:
                clause += f"，已降采样到长边 {IMAGE_CONTEXT_MAX_EDGE}"
            return delivered, clause, "输出原图坐标时加上区域偏移 (x, y)。"
        if full_resolution:
            if info.size_bytes > FULL_RESOLUTION_MAX_BYTES:
                raise ModelRetry(
                    f"这张图 {_bytes_label(info.size_bytes)}，超过按原分辨率读取的上限 "
                    f"{_bytes_label(FULL_RESOLUTION_MAX_BYTES)}；改用 region 按原图像素"
                    "坐标分块看。"
                )
            return url, "原分辨率", ""
        if max(info.width, info.height) > IMAGE_CONTEXT_MAX_EDGE:
            return (
                resized_image_url(url, max_edge=IMAGE_CONTEXT_MAX_EDGE),
                f"已降采样到长边 {IMAGE_CONTEXT_MAX_EDGE}",
                "要看清小字或细节，用 `region` 按原图像素坐标看一块。输出坐标一律按原图尺寸算。",
            )
        return url, "未缩放", ""

    async def _write(
        self, scope: str, key: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        """写入文件，将存储错误转换为 ModelRetry。"""

        try:
            return await self._capability.space.store.write(
                scope, key, content, expected_version=expected_version
            )
        except InvalidContent as exc:
            raise ModelRetry(str(exc)) from exc
        except QuotaExceeded as exc:
            if exc.scope == "file":
                raise ModelRetry(f"{exc}。把内容拆成几个文件，或者精简一些。") from exc
            raise ModelRetry(f"{exc}。用 list_files 找出不再需要的文件删掉。") from exc
        except VersionConflict as exc:
            raise ModelRetry(f"{exc}。用 read_file 重新读一遍，再基于新内容改。") from exc

    async def _entries(self, scope: str, prefix: str) -> Sequence[FileEntry]:
        try:
            return await self._capability.space.store.entries(scope, prefix=prefix)
        except InvalidPath as exc:
            raise ModelRetry(str(exc)) from exc


def workspace_capability(
    *, space: FileSpace, probe: MediaProbe, ledger: MaterialLedger
) -> Workspace[Any]:

    return Workspace[Any](space=space, probe=probe, ledger=ledger)


__all__ = [
    "CAPABILITY_ID",
    "FULL_RESOLUTION_MAX_BYTES",
    "MAX_READ_LINES",
    "MAX_SEARCH_RESULTS",
    "CropRegion",
    "Workspace",
    "WorkspaceToolset",
    "workspace_capability",
]
