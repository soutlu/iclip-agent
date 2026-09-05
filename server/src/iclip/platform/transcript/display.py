"""工具 display、结果渲染器（view）与给人看的结果形状。

客户端按 display.kind 画卡头、按 view 选卡身渲染器、按 metadata 的形状填卡身与角标；
能力包登记 display，组合根合并后供实时和历史投影共用。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import (
    Any,
    ClassVar,
    Final,
    Literal,
    NotRequired,
    Protocol,
    TypedDict,
    runtime_checkable,
)
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, ConfigDict


class _Display(BaseModel):
    """字段名照 kimi ``packages/protocol/src/display.ts``（snake_case），不套协议帧那套 camelCase：
    display 对协议帧来说是一个整体透传的值，客户端按 kimi 的合同解析它。"""

    model_config = ConfigDict(extra="forbid", frozen=True)


class FileIoDisplay(_Display):
    """读写一个文件。``path`` 是必需的，取不到就退回 ``generic``。

    ``content`` / ``before`` / ``after`` 是 kimi 合同里的可选项，给审批卡预览要写的内容与 diff。
    """

    kind: Literal["file_io"] = "file_io"
    operation: Literal["read", "write", "edit", "glob", "grep"]
    path: str
    content: str | None = None
    before: str | None = None
    after: str | None = None


class SearchDisplay(_Display):
    """按一个词检索。``scope`` 是检索范围，给不出就不给。"""

    kind: Literal["search"] = "search"
    query: str
    scope: str | None = None


class UrlFetchDisplay(_Display):
    """取一个地址上的东西。"""

    kind: Literal["url_fetch"] = "url_fetch"
    url: str


class SkillCallDisplay(_Display):
    """调用一个 skill。"""

    kind: Literal["skill_call"] = "skill_call"
    skill_name: str
    args: str | None = None


class AgentCallDisplay(_Display):
    """把活派给一个下属。"""

    kind: Literal["agent_call"] = "agent_call"
    agent_name: str
    prompt: str


class GenericDisplay(_Display):
    """兜底卡。``summary`` 是标题：书面动宾短语四到五字，不带数字、路径或口语缩略；
    ``detail`` 是主语：这一步作用的对象实例（文件名、镜头号）。数字进 metadata 的角标。"""

    kind: Literal["generic"] = "generic"
    summary: str
    detail: str | None = None


ToolDisplay = (
    FileIoDisplay
    | SearchDisplay
    | UrlFetchDisplay
    | SkillCallDisplay
    | AgentCallDisplay
    | GenericDisplay
)

DisplayFn = Callable[[Any], ToolDisplay | None]
"""由调用参数计算 display；返回 None 时注册表使用 generic。"""


# --- 结果渲染器与 metadata 形状 ------------------------------------------------
#
# view 选卡身渲染器，metadata 的形状由 view 决定；没有 view 的工具只能带 ToolNote。
# 形状用 TypedDict：实时对象与落库 JSON 反序列化结果保持同一份。

FILE_CONTENT_VIEW: Final = "file_content"
"""读文件：卡身是带行号的正文，正文仍在 output 里，metadata 只说明范围。"""

SEARCH_RESULTS_VIEW: Final = "search_results"
"""检索：卡身是逐条命中行。"""

MEDIA_GRID_VIEW: Final = "media_grid"
"""媒体：卡身是一排带图注的图。"""


class FileContentMeta(TypedDict):
    path: str
    lines: int
    truncated: bool


def file_content(path: str, *, lines: int, truncated: bool) -> FileContentMeta:
    return {"path": path, "lines": lines, "truncated": truncated}


class SearchMatch(TypedDict):
    file: str
    line: int
    text: str


class SearchResultsMeta(TypedDict):
    query: str
    matches: list[SearchMatch]
    truncated: bool


def search_results(
    query: str, matches: Iterable[tuple[str, int, str]], *, truncated: bool
) -> SearchResultsMeta:
    return {
        "query": query,
        "matches": [SearchMatch(file=file, line=line, text=text) for file, line, text in matches],
        "truncated": truncated,
    }


class MediaGridItem(TypedDict):
    """媒体网格中的 URL 与标题。"""

    url: str
    caption: str


class MediaGridItems(TypedDict):
    """供 media_grid 渲染器使用的工具 metadata；``note`` 是角标原文，由工具写好。"""

    items: list[MediaGridItem]
    note: NotRequired[str]


def media_grid(items: Iterable[tuple[str, str]], *, note: str | None = None) -> MediaGridItems:
    """统一构造媒体网格结果。"""

    grid: MediaGridItems = {
        "items": [MediaGridItem(url=url, caption=caption) for url, caption in items]
    }
    if note is not None:
        grid["note"] = note
    return grid


class ToolNote(TypedDict, total=False):
    """没有卡身渲染器的工具能带的角标：``chip`` 原文，或改文件的增删行数；
    ``body`` 为 ``none`` 时结果正文不给展开（整篇规范这类没人看的正文）。"""

    chip: str
    added: int
    removed: int
    body: Literal["none"]


def tool_note(chip: str | None = None, *, body: Literal["none"] | None = None) -> ToolNote:
    note: ToolNote = {}
    if chip is not None:
        note["chip"] = chip
    if body is not None:
        note["body"] = body
    return note


def diff_note(added: int, removed: int) -> ToolNote:
    return {"added": added, "removed": removed}


def url_filename(url: str) -> str | None:
    """地址最后一段的文件名，给卡头当主语；解析不出就不给。"""

    path = urlsplit(url).path
    name = unquote(path.rsplit("/", 1)[-1]) if path else ""
    return name or None


def _as_mapping(args: Any) -> Any:
    """解析流式工具参数 JSON；无效 JSON 按缺少参数处理。"""

    if not isinstance(args, str):
        return args
    try:
        return json.loads(args)
    except json.JSONDecodeError:
        return None


@dataclass(frozen=True, slots=True)
class ToolDisplayEntry:
    """工具的 display 函数和结果渲染器。"""

    draw: DisplayFn
    view: str | None = None


@dataclass(frozen=True, slots=True)
class ToolDisplayRegistry:
    """实时与历史投影共享的工具 display 注册表。"""

    entries: Mapping[str, ToolDisplayEntry]

    EMPTY: ClassVar[ToolDisplayRegistry]
    """供测试使用的空注册表；生产投影须使用已装配的注册表。"""

    def tool_display(self, name: str, args: Any) -> ToolDisplay:
        """查找工具 display，未登记或无法计算时使用 generic。"""

        entry = self.entries.get(name)
        if entry is not None:
            display = entry.draw(_as_mapping(args))
            if display is not None:
                return display
        return GenericDisplay(summary=name)

    def view_of(self, name: str) -> str | None:
        """返回已登记的结果渲染器；缺失时由客户端使用 generic。"""

        entry = self.entries.get(name)
        return None if entry is None else entry.view

    @staticmethod
    def merged(*tables: Mapping[str, DisplayFn | ToolDisplayEntry]) -> ToolDisplayRegistry:
        """合并能力 display 表；重复工具名报错，渲染器可省略。"""

        entries: dict[str, ToolDisplayEntry] = {}
        for table in tables:
            for name, registered in table.items():
                if name in entries:
                    raise ValueError(f"工具 {name!r} 的画法登记了两遍；一件工具只归一个能力。")
                entries[name] = (
                    registered
                    if isinstance(registered, ToolDisplayEntry)
                    else ToolDisplayEntry(draw=registered)
                )
        return ToolDisplayRegistry(entries)


ToolDisplayRegistry.EMPTY = ToolDisplayRegistry({})


@runtime_checkable
class ToolDisplaySource(Protocol):
    """提供 display 表的能力接口，供组合根合并。"""

    def display_table(self) -> Mapping[str, DisplayFn | ToolDisplayEntry]: ...


__all__ = [
    "FILE_CONTENT_VIEW",
    "MEDIA_GRID_VIEW",
    "SEARCH_RESULTS_VIEW",
    "AgentCallDisplay",
    "DisplayFn",
    "FileContentMeta",
    "FileIoDisplay",
    "GenericDisplay",
    "MediaGridItem",
    "MediaGridItems",
    "SearchDisplay",
    "SearchMatch",
    "SearchResultsMeta",
    "SkillCallDisplay",
    "ToolDisplay",
    "ToolDisplayEntry",
    "ToolDisplayRegistry",
    "ToolDisplaySource",
    "ToolNote",
    "UrlFetchDisplay",
    "diff_note",
    "file_content",
    "media_grid",
    "search_results",
    "tool_note",
    "url_filename",
]
