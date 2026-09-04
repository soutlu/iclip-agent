"""工具卡怎么画：display 的类型与合表。

**客户端不认工具名**，它只认这个字段里的 ``kind``（协议定死的一个封闭联合）。哪件工具画成什么
由拥有它的那个能力包登记（与工具同文件），组合根把各能力的表合成一份注册表，同一实例递给实时
与历史两条路。这里只留类型与合表。

认不出的一律 ``generic``：卡片画得朴素而已，不会画错。
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
"""一件工具的画法：收这一次调用的参数（dict、JSON 字串，或者什么都没有），算不出来就返回
``None``，由注册表退回 ``generic``。"""


class MediaGridItem(TypedDict):
    """媒体墙上的一张：地址加一句标题。"""

    url: str
    caption: str


class MediaGridItems(TypedDict):
    """一件出图 / 拼板工具给人看的结果，配 ``view="media_grid"``。

    是 TypedDict 而不是 pydantic 模型：这份东西要经 ``ToolReturn.metadata`` 落库再读回来，实时
    那条路拿到的是工具刚造出来的对象、历史那条路拿到的是从库里解出来的。模型对象与 dict 比不
    相等，两条路会当场分叉，而分叉不报错。
    """

    items: list[MediaGridItem]


def media_grid(items: Iterable[tuple[str, str]]) -> MediaGridItems:
    """把（地址，标题）拼成界面那份缩略图墙。各能力共用，键名只写一遍。"""

    return {"items": [MediaGridItem(url=url, caption=caption) for url, caption in items]}


def _as_mapping(args: Any) -> Any:
    """参数在消息里可能是 JSON 字串（模型逐字发出来的那份）。解不出来按「没有参数」处理。"""

    if not isinstance(args, str):
        return args
    try:
        return json.loads(args)
    except json.JSONDecodeError:
        return None


@dataclass(frozen=True, slots=True)
class ToolDisplayEntry:
    """一件工具登记的两样东西：卡怎么画，结果用哪个渲染器画。"""

    draw: DisplayFn
    view: str | None = None


@dataclass(frozen=True, slots=True)
class ToolDisplayRegistry:
    """全部工具的画法。

    实时那条路与历史那条路必须拿到同一份：两边给出的卡不一样的话，同一张卡在刷新前后会换个
    长相，而且不报错。
    """

    entries: Mapping[str, ToolDisplayEntry]

    EMPTY: ClassVar[ToolDisplayRegistry]
    """一张都没登记。测试的 helper 用它，生产的两条路都要拿真的那一份。"""

    def tool_display(self, name: str, args: Any) -> ToolDisplay:
        """这件工具这一次调用该画成什么。查不到、或者算不出来都退回 ``generic``。"""

        entry = self.entries.get(name)
        if entry is not None:
            display = entry.draw(_as_mapping(args))
            if display is not None:
                return display
        return GenericDisplay(summary=name)

    def view_of(self, name: str) -> str | None:
        """这件工具的结果用哪个渲染器画。没登记就不给，前端走 generic。"""

        entry = self.entries.get(name)
        return None if entry is None else entry.view

    @staticmethod
    def merged(*tables: Mapping[str, DisplayFn | ToolDisplayEntry]) -> ToolDisplayRegistry:
        """把各能力的表合成一份。同一件工具在两张表里出现即装配期报错。

        只给画法不给渲染器的表照收：多数工具的结果没有专门的渲染器。
        """

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
    """自带一张 display 表的能力。组合根按它挑出该合进注册表的那些。"""

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
