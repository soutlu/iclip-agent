"""工具 display 类型与注册表。

客户端按 kind 渲染；能力包登记 display，组合根合并后供实时和历史投影共用。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, ClassVar, Literal, Protocol, TypedDict, runtime_checkable

from pydantic import BaseModel, ConfigDict


class _Display(BaseModel):
    """字段名照 kimi ``packages/protocol/src/display.ts``（snake_case），不套协议帧那套 camelCase：
    display 对协议帧来说是一个整体透传的值，客户端按 kimi 的合同解析它。"""

    model_config = ConfigDict(extra="forbid", frozen=True)


class FileIoDisplay(_Display):
    """读写一个文件。``path`` 是必需的，取不到就退回 ``generic``。"""

    kind: Literal["file_io"] = "file_io"
    operation: Literal["read", "write", "edit", "glob", "grep"]
    path: str


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
    """兜底：给一句话，客户端照它画一张朴素的卡。"""

    kind: Literal["generic"] = "generic"
    summary: str


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


class MediaGridItem(TypedDict):
    """媒体网格中的 URL 与标题。"""

    url: str
    caption: str


class MediaGridItems(TypedDict):
    """供 media_grid 渲染器使用的工具 metadata。

    使用 TypedDict 保持实时对象与数据库 JSON 反序列化结果一致。
    """

    items: list[MediaGridItem]


def media_grid(items: Iterable[tuple[str, str]]) -> MediaGridItems:
    """统一构造媒体网格结果。"""

    return {"items": [MediaGridItem(url=url, caption=caption) for url, caption in items]}


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
    "AgentCallDisplay",
    "DisplayFn",
    "FileIoDisplay",
    "GenericDisplay",
    "MediaGridItem",
    "MediaGridItems",
    "SearchDisplay",
    "SkillCallDisplay",
    "ToolDisplay",
    "ToolDisplayEntry",
    "ToolDisplayRegistry",
    "ToolDisplaySource",
    "UrlFetchDisplay",
    "media_grid",
]
