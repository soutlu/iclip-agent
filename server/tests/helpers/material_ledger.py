"""素材台账的进程内替身。

判定和真库一样只有一条：``(命名空间, url)`` 逐字相等。重记同一个地址保留先记的那
条，对应真库那句 ``ON CONFLICT DO NOTHING``。
"""

from __future__ import annotations

from collections.abc import Sequence

from iclip.platform.material_ledger.store import Material


class FakeMaterialLedger:
    """内存字典版的 ``MaterialLedger``。"""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], Material] = {}

    async def record(self, namespace: str, materials: Sequence[Material]) -> None:
        for material in materials:
            self.rows.setdefault((namespace, material.url), material)

    async def lookup(self, namespace: str, url: str) -> Material | None:
        return self.rows.get((namespace, url))

    async def purge_namespace(self, namespace: str) -> None:
        for key in [key for key in self.rows if key[0] == namespace]:
            del self.rows[key]

    def urls(self, namespace: str) -> set[str]:
        """这个命名空间下记着的全部地址，断言用。"""

        return {url for space, url in self.rows if space == namespace}


__all__ = ["FakeMaterialLedger"]
