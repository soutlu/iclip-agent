"""素材账本的持久化端口。

**只有登记一条写路径**：素材是账本上的事实，登记完既不改也不删。这一版连删除都没有
——那是后面的功能，不是这一层现在该留的口子。

**读没有属主参数**：素材是全公司共用的，谁有 ``assets:read`` 谁就看得见全部；
``creator_user_id`` 是查询维度，不是访问边界。
"""

from __future__ import annotations

import uuid
from typing import Protocol

from iclip.domains.assets.models import Asset, AssetType


class AssetRepository(Protocol):
    """``iclip.media_assets`` 的数据访问。"""

    async def register(self, asset: Asset) -> Asset:
        """登记一份素材，返回落库后的整行。

        **幂等**：这一行已经在了就原样返回它，不报错也不覆盖。登记是客户端传完文件
        之后自己发起的，它断线重试是正常路径。
        """
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
