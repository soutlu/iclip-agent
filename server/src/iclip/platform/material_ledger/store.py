"""素材台账协议。

以原始 URL 字符串精确识别素材，不解析或归一化；访问范围由命名空间限定。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

MaterialKind = Literal["image", "video"]
"""工具支持的素材类型。"""


@dataclass(frozen=True, slots=True)
class Material:
    """图片或视频素材及其 URL。"""

    url: str
    kind: MaterialKind


class MaterialLedger(Protocol):
    """按命名空间登记素材；相同 (namespace, url) 重复登记保留首条记录。"""

    async def record(self, namespace: str, materials: Sequence[Material]) -> None: ...

    async def lookup(self, namespace: str, url: str) -> Material | None: ...

    async def purge_namespace(self, namespace: str) -> None: ...


__all__ = ["Material", "MaterialKind", "MaterialLedger"]
