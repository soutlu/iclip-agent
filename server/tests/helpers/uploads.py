"""uploads 测试替身。"""

from __future__ import annotations

from collections.abc import Mapping

from iclip.platform.object_store.oss import StoredObject


class FakeBucket:
    """SignedUploadStore 内存替身；``put`` 模拟浏览器直传，测试负责填充对象。"""

    def __init__(self, *, base: str = "https://cdn.test") -> None:
        self.base = base
        self.objects: dict[str, StoredObject] = {}
        self.signed: list[tuple[str, dict[str, str]]] = []

    def put(self, object_key: str, *, content_type: str, size_bytes: int = 1024) -> None:
        self.objects[object_key] = StoredObject(
            object_key=object_key, content_type=content_type, size_bytes=size_bytes
        )

    def sign_put(self, *, object_key: str, headers: Mapping[str, str]) -> str:
        self.signed.append((object_key, dict(headers)))
        return f"{self.base}/{object_key}?signed"

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        for key, stored in self.objects.items():
            if key.startswith(prefix):
                return stored
        return None

    def public_url(self, object_key: str) -> str:
        return f"{self.base}/{object_key}"


__all__ = ["FakeBucket"]
