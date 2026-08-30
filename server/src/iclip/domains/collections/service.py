"""合集的用例层：开口袋、改名、删口袋。

**合集只对属主可见。** 别人的一律 ``NotFound``（不泄露存在性），治理者例外——内部平台
要复盘创作质量，所以持 ``users:manage`` 的人能列出、读到全部合集。写入没有这个例外之
外的口子：改名与删除只有属主或治理者能做。
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Literal

from iclip.common.errors import PermissionDenied
from iclip.domains.collections.models import Collection
from iclip.domains.collections.repository import CollectionRepository
from iclip.domains.collections.schemas import MAX_LIST_LIMIT
from iclip.domains.identity.public import Principal

MANAGE_PERMISSION = "users:manage"

Scope = Literal["me", "all"]


class CollectionService:
    """建合集、读合集、改它、删它。"""

    def __init__(self, repo: CollectionRepository) -> None:
        self._repo = repo

    def _visible_to(self, principal: Principal, *, scope: Scope = "me") -> uuid.UUID | None:
        """这次操作按谁的名下算。``None`` 表示不按属主过滤，只有治理者拿得到。"""

        if scope == "me":
            return principal.user_id
        if not principal.has(MANAGE_PERMISSION):
            raise PermissionDenied("只有治理者能看全部合集")
        return None

    async def create(self, principal: Principal, *, name: str) -> Collection:
        """开一个新合集，归到发起人名下。"""

        now = datetime.now(UTC)
        return await self._repo.create(
            Collection(
                id=uuid.uuid4(),
                owner_user_id=principal.user_id,
                name=name,
                created_at=now,
                updated_at=now,
            )
        )

    async def get(self, principal: Principal, collection_id: uuid.UUID) -> Collection:
        """读一个合集。别人的是 404，治理者除外。"""

        owner = None if principal.has(MANAGE_PERMISSION) else principal.user_id
        return await self._repo.get(collection_id, owner=owner)

    async def list_recent(
        self, principal: Principal, *, scope: Scope = "me", limit: int = 20, offset: int = 0
    ) -> tuple[Collection, ...]:
        """列出合集，最近改动的排前面。``scope="all"`` 是治理者的全量视图。"""

        return await self._repo.list_recent(
            owner=self._visible_to(principal, scope=scope),
            limit=min(limit, MAX_LIST_LIMIT),
            offset=offset,
        )

    async def rename(
        self, principal: Principal, collection_id: uuid.UUID, *, name: str
    ) -> Collection:
        """改名。只有属主或治理者能改，别人看不见这个合集，所以是 404 不是 403。"""

        owner = None if principal.has(MANAGE_PERMISSION) else principal.user_id
        return await self._repo.rename(collection_id, owner=owner, name=name)

    async def delete(self, principal: Principal, collection_id: uuid.UUID) -> None:
        """删合集。口径同改名。"""

        owner = None if principal.has(MANAGE_PERMISSION) else principal.user_id
        await self._repo.delete(collection_id, owner=owner)


__all__ = ["MANAGE_PERMISSION", "CollectionService", "Scope"]
