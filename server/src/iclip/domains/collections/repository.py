"""合集的持久化端口。

每个方法都收一个 ``owner``：合集只对属主可见。给 ``None`` 表示不按属主过滤，那是治理
者的全量视图专用——调用方必须先验过权限，这一层只照办。
"""

from __future__ import annotations

import uuid
from typing import Protocol

from iclip.domains.collections.models import Collection


class CollectionRepository(Protocol):
    """``iclip.collections`` 的数据访问。"""

    async def create(self, collection: Collection) -> Collection:
        """插入一行新合集，返回落库后的整行。"""
        ...

    async def get(self, collection_id: uuid.UUID, *, owner: uuid.UUID | None) -> Collection:
        """按 id 读一行；不是这个人的一律抛 ``NotFound``（不泄露它存不存在）。"""
        ...

    async def list_recent(
        self, *, owner: uuid.UUID | None, limit: int, offset: int = 0
    ) -> tuple[Collection, ...]:
        """按最近改动倒序列出合集。"""
        ...

    async def rename(
        self, collection_id: uuid.UUID, *, owner: uuid.UUID | None, name: str
    ) -> Collection:
        """改名，返回改完的整行。"""
        ...

    async def delete(self, collection_id: uuid.UUID, *, owner: uuid.UUID | None) -> None:
        """删掉这一行。已经不在了就抛 ``NotFound``。

        装在里面的对话只是把归属那一列置空——口袋没了，对话还在。这条由外键写在表上，
        不在这一层重做。
        """
        ...


__all__ = ["CollectionRepository"]
