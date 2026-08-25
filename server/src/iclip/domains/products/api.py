"""产品资料的 HTTP 面：一个端点，精确款号查一个款，零副作用。

权限用现成的 ``assets:read``——查产品资料是为了挑素材，和「能读东西」是同一件事，
三个预置角色都已经有它，不为此新造一个权限名。

没配目录库时整个路由不挂载（同 SSO、媒体生成的口径），所以这里不必判「上游没配」。
"""

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
