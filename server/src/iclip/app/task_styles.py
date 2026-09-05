"""StyleSnapshots 的组合根实现：查询产品资料并转存封面，保证历史需求单使用创建时快照。"""

from __future__ import annotations

import hashlib
from pathlib import PurePosixPath
from urllib.parse import urlsplit

import httpx

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.products.catalog_pg import PgProductCatalog
from iclip.domains.tasks.schemas import TaskStyle
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.oss import PublicObjectStore

_DOWNLOAD_TIMEOUT_SECONDS = 20.0
_FALLBACK_IMAGE_CONTENT_TYPE = "image/jpeg"


class ProductStyleSnapshots:
    """读取 PDM 产品并转存首图，生成可持久化的款号快照。"""

    def __init__(self, catalog: PgProductCatalog, store: PublicObjectStore) -> None:
        self._catalog = catalog
        self._store = store

    async def of(self, style_no: str) -> TaskStyle:
        try:
            product = await self._catalog.find(style_no)
        except NotFound as exc:
            # 款号不存在属于创建参数无效，不能作为需求单 404 返回。
            raise ValidationFailed(f"款号 {style_no} 在产品资料里查不到") from exc

        first_image = product.images[0] if product.images else None
        return TaskStyle(
            style_no=product.style_no,
            # 名称缺失时展示编码，两者均缺失时为空。
            brand=product.brand.name or product.brand.code or "",
            category=product.category.name or product.category.code or "",
            preview_image_url=(
                await self._mirror(first_image.url) if first_image is not None else ""
            ),
        )

    async def _mirror(self, source_url: str) -> str:
        """转存产品图并返回公开地址；失败向上传播，创建需求单整体失败。"""

        async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT_SECONDS) as client:
            response = await client.get(source_url, follow_redirects=True)
            response.raise_for_status()
            content = response.content
            content_type = (response.headers.get("content-type") or "").split(";")[0].strip()

        return await self._store.put_public_object(
            object_key=_preview_object_key(source_url),
            content=content,
            # 修正上游通用二进制类型，避免浏览器将图片作为附件下载。
            content_type=(
                content_type if content_type.startswith("image/") else _FALLBACK_IMAGE_CONTENT_TYPE
            ),
        )


def _preview_object_key(source_url: str) -> str:
    """由源地址派生稳定对象 key；实际 MIME 类型由上传的 Content-Type 决定。"""

    return MEDIA_PATHS.task_style_cover(
        digest=hashlib.sha256(source_url.encode()).hexdigest(),
        ext=PurePosixPath(urlsplit(source_url).path).suffix.lstrip(".").lower() or "jpg",
    )


class UnavailableStyleSnapshots:
    """基础设施未配置时明确拒绝快照请求。"""

    async def of(self, style_no: str) -> TaskStyle:
        raise ValidationFailed(
            f"服务端没配产品资料库或对象存储，记不下款号 {style_no}，提不了需求单"
        )


__all__ = ["ProductStyleSnapshots", "UnavailableStyleSnapshots"]
