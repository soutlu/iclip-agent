"""素材台账的契约：素材的形状与后端 Protocol。

素材的身份就是那个 url 字符串，原样存原样查——不解析、不归一化、不看域名。查得到
就是这段对话能用的素材，查不到就不是。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

MaterialKind = Literal["image", "video"]
"""台账记得下的种类。图和视频之外的东西没有工具收，不登记。"""


@dataclass(frozen=True, slots=True)
class Material:
    """一份素材：地址，以及它是图还是视频。"""

    url: str
    kind: MaterialKind


class MaterialLedger(Protocol):
    """按命名空间记素材的后端。

    ``record`` 幂等：同一个 ``(namespace, url)`` 再记一次不报错、也不改原来那行。
    """

    async def record(self, namespace: str, materials: Sequence[Material]) -> None: ...

    async def lookup(self, namespace: str, url: str) -> Material | None: ...

    async def purge_namespace(self, namespace: str) -> None: ...


__all__ = ["Material", "MaterialKind", "MaterialLedger"]
