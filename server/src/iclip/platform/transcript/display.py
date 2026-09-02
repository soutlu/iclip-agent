"""工具卡怎么画：display 的类型与合表。

**客户端不认工具名**，它只认这个字段里的 ``kind``（协议定死的一个封闭联合）。哪件工具画成什么
由拥有它的那个能力包登记（与工具同文件），组合根把各能力的表合成一份注册表，同一实例递给实时
与历史两条路。这里只留类型与合表。

认不出的一律 ``generic``：卡片画得朴素而已，不会画错。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, ClassVar, Literal, Protocol, runtime_checkable

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


def _as_mapping(args: Any) -> Any:
    """参数在消息里可能是 JSON 字串（模型逐字发出来的那份）。解不出来按「没有参数」处理。"""

    if not isinstance(args, str):
        return args
    try:
        return json.loads(args)
    except json.JSONDecodeError:
        return None


@dataclass(frozen=True, slots=True)
class ToolDisplayRegistry:
    """全部工具的画法。

    实时那条路与历史那条路必须拿到同一份：两边给出的卡不一样的话，同一张卡在刷新前后会换个
    长相，而且不报错。
    """

    entries: Mapping[str, DisplayFn]

    EMPTY: ClassVar[ToolDisplayRegistry]
    """一张都没登记。测试的 helper 用它，生产的两条路都要拿真的那一份。"""

    def tool_display(self, name: str, args: Any) -> ToolDisplay:
        """这件工具这一次调用该画成什么。查不到、或者算不出来都退回 ``generic``。"""

        draw = self.entries.get(name)
        if draw is not None:
            display = draw(_as_mapping(args))
            if display is not None:
                return display
        return GenericDisplay(summary=name)

    @staticmethod
    def merged(*tables: Mapping[str, DisplayFn]) -> ToolDisplayRegistry:
        """把各能力的表合成一份。同一件工具在两张表里出现即装配期报错。"""

        entries: dict[str, DisplayFn] = {}
        for table in tables:
            for name, draw in table.items():
                if name in entries:
                    raise ValueError(f"工具 {name!r} 的画法登记了两遍；一件工具只归一个能力。")
                entries[name] = draw
        return ToolDisplayRegistry(entries)


ToolDisplayRegistry.EMPTY = ToolDisplayRegistry({})


@runtime_checkable
class ToolDisplaySource(Protocol):
    """自带一张 display 表的能力。组合根按它挑出该合进注册表的那些。"""

    def display_table(self) -> Mapping[str, DisplayFn]: ...


__all__ = [
    "AgentCallDisplay",
    "DisplayFn",
    "FileIoDisplay",
    "GenericDisplay",
    "SearchDisplay",
    "SkillCallDisplay",
    "ToolDisplay",
    "ToolDisplayRegistry",
    "ToolDisplaySource",
    "UrlFetchDisplay",
]
