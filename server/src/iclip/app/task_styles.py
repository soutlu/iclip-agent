"""需求单要的那份款号快照（``domains/tasks/ports.py`` 的 ``StyleSnapshots``）的真身。

它接在组合根，因为抄快照要同时碰产品资料库和对象存储，而需求单域不认识那两个地盘。

封面要转存：产品资料给的是上游图库地址，上游换图之后就烂了。对象 key 由源地址派生，
所以同一张产品图被多少张需求单引用都只搬一次。
"""

from __future__ import annotations

import hashlib
from pathlib import PurePosixPath
from urllib.parse import urlsplit

import httpx

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.products.catalog_pg import PgProductCatalog
from iclip.domains.tasks.schemas import TaskStyle
from iclip.platform.object_store.oss import PublicObjectStore

_OSS_PREFIX = "task-styles"
_DOWNLOAD_TIMEOUT_SECONDS = 20.0
_FALLBACK_IMAGE_CONTENT_TYPE = "image/jpeg"


class ProductStyleSnapshots:
    """``StyleSnapshots`` 的真身：查 PDM，把首图转存，凑出一份可冻结的快照。"""

    def __init__(self, catalog: PgProductCatalog, store: PublicObjectStore) -> None:
        self._catalog = catalog
        self._store = store

    async def of(self, style_no: str) -> TaskStyle:
        try:
            product = await self._catalog.find(style_no)
        except NotFound as exc:
            # 请求里给的款不存在，是这次提交的参数错了，不是「需求单不存在」。
            raise ValidationFailed(f"款号 {style_no} 在产品资料里查不到") from exc

        first_image = product.images[0] if product.images else None
        return TaskStyle(
            style_no=product.style_no,
            # 码一定有、名字可能没有（产品资料域的口径）。名字没有就退回码，两个都
            # 没有就空着——空着看得见，猜错看不见。
            brand=product.brand.name or product.brand.code or "",
            category=product.category.name or product.category.code or "",
            preview_image_url=(
                await self._mirror(first_image.url) if first_image is not None else ""
            ),
        )

    async def _mirror(self, source_url: str) -> str:
        """把一张产品图搬进对象存储，返回公网地址。

        失败直接往外抛：这一步在落库之前，所以整次创建不成立，不会留下碎图封面。
        """

        async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT_SECONDS) as client:
            response = await client.get(source_url, follow_redirects=True)
            response.raise_for_status()
            content = response.content
            content_type = (response.headers.get("content-type") or "").split(";")[0].strip()

        return await self._store.put_public_object(
            object_key=_preview_object_key(source_url),
            content=content,
            # 上游偶尔报个 application/octet-stream，照抄的话浏览器会当附件下载。
            content_type=(
                content_type if content_type.startswith("image/") else _FALLBACK_IMAGE_CONTENT_TYPE
            ),
        )


def _preview_object_key(source_url: str) -> str:
    """源地址 → 稳定的对象 key。后缀只是好认，实际类型由写入时的 content type 决定。"""

    digest = hashlib.sha256(source_url.encode()).hexdigest()
    suffix = PurePosixPath(urlsplit(source_url).path).suffix.lstrip(".").lower() or "jpg"
    return f"{_OSS_PREFIX}/{digest}.{suffix}"


class UnavailableStyleSnapshots:
    """没配产品资料库或对象存储时占的位：直接拒绝，不记一份空快照混过去。"""

    async def of(self, style_no: str) -> TaskStyle:
        raise ValidationFailed(
            f"服务端没配产品资料库或对象存储，记不下款号 {style_no}，提不了需求单"
        )


__all__ = ["ProductStyleSnapshots", "UnavailableStyleSnapshots"]
