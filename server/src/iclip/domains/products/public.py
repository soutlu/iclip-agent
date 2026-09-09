"""products 的跨模块契约：其它模块只准从这里 import。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Protocol

from iclip.domains.products.models import StyleGrouping


class StyleDirectory(Protocol):
    """按 PDM 款号批量取品类与品牌的窄端口。"""

    async def resolve(self, style_nos: Sequence[str]) -> Mapping[str, StyleGrouping]:
        """返回 ``款号 -> 品类与品牌``；查不到或归属缺失的款不出现在结果里。"""

        ...


__all__ = ["StyleDirectory", "StyleGrouping"]
