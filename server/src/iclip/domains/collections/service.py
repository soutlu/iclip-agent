"""合集用例。属主与治理者可读写合集；其他主体访问时返回 NotFound。"""

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
    def __init__(self, repo: CollectionRepository) -> None:
        self._repo = repo

    def _visible_to(self, principal: Principal, *, scope: Scope = "me") -> uuid.UUID | None:
        """返回属主过滤条件；仅治理者可在 scope="all" 时获得 None。"""

        if scope == "me":
            return principal.user_id
        if not principal.has(MANAGE_PERMISSION):
            raise PermissionDenied("只有治理者能看全部合集")
        return None

    async def create(self, principal: Principal, *, name: str) -> Collection:

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
        """读取合集；非属主且无治理权限时返回 404。"""

        owner = None if principal.has(MANAGE_PERMISSION) else principal.user_id
        return await self._repo.get(collection_id, owner=owner)

    async def list_recent(
        self, principal: Principal, *, scope: Scope = "me", limit: int = 20, offset: int = 0
    ) -> tuple[Collection, ...]:
        """按最近修改时间倒序返回合集；scope="all" 需要治理权限。"""

        return await self._repo.list_recent(
            owner=self._visible_to(principal, scope=scope),
            limit=min(limit, MAX_LIST_LIMIT),
            offset=offset,
        )

    async def rename(
        self, principal: Principal, collection_id: uuid.UUID, *, name: str
    ) -> Collection:
        """仅属主或治理者可改名；其他主体返回 404，避免泄露合集存在性。"""

        owner = None if principal.has(MANAGE_PERMISSION) else principal.user_id
        return await self._repo.rename(collection_id, owner=owner, name=name)

    async def delete(self, principal: Principal, collection_id: uuid.UUID) -> None:

        owner = None if principal.has(MANAGE_PERMISSION) else principal.user_id
        await self._repo.delete(collection_id, owner=owner)


__all__ = ["MANAGE_PERMISSION", "CollectionService", "Scope"]
