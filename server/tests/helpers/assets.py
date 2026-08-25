"""assets 测试替身。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from iclip.common.errors import NotFound
from iclip.domains.assets.models import Asset, AssetType
from iclip.platform.object_store.oss import StoredObject


class InMemoryAssetRepository:
    """``AssetRepository`` 的内存替身。

    ``register`` 照样幂等：那是这个端口的语义，替身少守一条，单测就测不出「客户端
    重试登记两次」这类回归。
    """

    def __init__(self, assets: list[Asset] | None = None) -> None:
        self.assets: dict[uuid.UUID, Asset] = {asset.id: asset for asset in assets or []}

    async def register(self, asset: Asset) -> Asset:
        stored = self.assets.setdefault(asset.id, asset)
        return stored

    async def get(self, asset_id: uuid.UUID) -> Asset:
        found = self.assets.get(asset_id)
        if found is None:
            raise NotFound("没有这份素材")
        return found

    async def list_recent(
        self,
        *,
        creator_user_id: uuid.UUID | None = None,
        asset_type: AssetType | None = None,
        limit: int,
    ) -> tuple[Asset, ...]:
        rows = [
            asset
            for asset in self.assets.values()
            if (creator_user_id is None or asset.creator_user_id == creator_user_id)
            and (asset_type is None or asset.asset_type == asset_type)
        ]
        rows.sort(key=lambda asset: asset.created_at, reverse=True)
        return tuple(rows[:limit])


class FakeBucket:
    """``SignedUploadStore`` 的内存替身：桶里有什么由测试直接摆。

    ``put`` 就是「浏览器拿着签名地址传上去了」这件事的替身——真实路径里那一步不经过
    我们的进程。
    """

    def __init__(self, *, base: str = "https://cdn.test") -> None:
        self.base = base
        self.objects: dict[str, StoredObject] = {}
        self.signed: list[tuple[str, str]] = []

    def put(self, object_key: str, *, content_type: str, size_bytes: int = 1024) -> None:
        self.objects[object_key] = StoredObject(
            object_key=object_key, content_type=content_type, size_bytes=size_bytes
        )

    def sign_put(self, *, object_key: str, content_type: str) -> str:
        self.signed.append((object_key, content_type))
        return f"{self.base}/{object_key}?signed"

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        for key, stored in self.objects.items():
            if key.startswith(prefix):
                return stored
        return None

    def public_url(self, object_key: str) -> str:
        return f"{self.base}/{object_key}"


def make_asset(
    *,
    asset_id: uuid.UUID | None = None,
    creator_user_id: uuid.UUID | None = None,
    asset_type: AssetType = "image",
    object_key: str = "iclip/agent/uploads/x.jpg",
    content_type: str = "image/jpeg",
    size_bytes: int = 1024,
    created_at: datetime | None = None,
) -> Asset:
    return Asset(
        id=asset_id or uuid.uuid4(),
        creator_user_id=creator_user_id or uuid.uuid4(),
        api_key_id=None,
        asset_type=asset_type,
        object_key=object_key,
        content_type=content_type,
        size_bytes=size_bytes,
        created_at=created_at or datetime.now(UTC),
    )


__all__ = ["FakeBucket", "InMemoryAssetRepository", "make_asset"]
