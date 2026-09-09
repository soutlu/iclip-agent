"""assets 测试替身。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from iclip.common.errors import NotFound
from iclip.domains.assets.models import Asset, AssetType
from iclip.platform.object_store.oss import StoredObject


class InMemoryAssetRepository:
    """AssetRepository 内存替身，保留 register 的幂等语义。"""

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
    """PublicBucket 内存替身；put 模拟浏览器直传，测试负责填充对象。"""

    def __init__(self, *, base: str = "https://cdn.test") -> None:
        self.base = base
        self.objects: dict[str, StoredObject] = {}
        self.signed: list[tuple[str, str]] = []

    def put(self, object_key: str, *, content_type: str, size_bytes: int = 1024) -> None:
        self.objects[object_key] = StoredObject(
            object_key=object_key, content_type=content_type, size_bytes=size_bytes
        )

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:

        self.put(object_key, content_type=content_type, size_bytes=len(content))
        return self.public_url(object_key)

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
