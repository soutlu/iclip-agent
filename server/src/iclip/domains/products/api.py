"""按 PDM 款号只读查询产品资料，使用 assets:read 权限；目录库未配置时不挂载路由。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.products.catalog_pg import PgProductCatalog
from iclip.domains.products.schemas import ProductEnvelope, product_out

MAX_STYLE_NO_CHARS = 64


def create_products_router(catalog: PgProductCatalog) -> APIRouter:
    router = APIRouter(prefix="/products", tags=["products"])

    @router.get("/{style_no}", response_model=ProductEnvelope)
    async def get_product(
        style_no: Annotated[str, Path(min_length=1, max_length=MAX_STYLE_NO_CHARS)],
        _principal: Annotated[Principal, Depends(require_permission("assets:read"))],
    ) -> ProductEnvelope:
        return ProductEnvelope(product=product_out(await catalog.find(style_no)))

    return router


__all__ = ["MAX_STYLE_NO_CHARS", "create_products_router"]
