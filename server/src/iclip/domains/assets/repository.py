"""素材持久化端口，仅支持登记和读取。素材全公司共享，creator_user_id 仅用于筛选。"""

from __future__ import annotations

import uuid
from typing import Protocol

from iclip.domains.assets.models import Asset, AssetType


class AssetRepository(Protocol):
    """``iclip.media_assets`` 的数据访问。"""

    async def register(self, asset: Asset) -> Asset:
        """幂等登记素材：已存在时返回原记录，不覆盖。"""
        ...

    async def get(self, asset_id: uuid.UUID) -> Asset:
        """按 id 读一行；没有这一行就抛 ``NotFound``。"""
        ...

    async def list_recent(
        self,
        *,
        creator_user_id: uuid.UUID | None = None,
        asset_type: AssetType | None = None,
        limit: int,
    ) -> tuple[Asset, ...]:
        """按登记时间倒序列出素材；两个筛选条件给了才生效。"""
        ...


__all__ = ["AssetRepository"]
