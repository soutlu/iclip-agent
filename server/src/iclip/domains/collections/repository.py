"""合集持久化端口。owner=None 取消属主过滤，调用方必须先校验治理权限。"""

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
        """删除合集；不存在时抛 NotFound。外键将关联对话的合集归属置空，保留对话。"""
        ...


__all__ = ["CollectionRepository"]
