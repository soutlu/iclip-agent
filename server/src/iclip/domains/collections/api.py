"""合集的 HTTP 面。

五个端点：开一个、列出、读一个、改名、删掉。读用 ``collections:read``，会改动的用
``collections:write``。

合集只对属主可见，所以别人的合集一律 404（不泄露存在性）；``scope=all`` 是治理者的
全量视图，没有 ``users:manage`` 就 403。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from iclip.domains.collections.schemas import (
    CollectionEnvelope,
    CollectionIn,
    CollectionsPageOut,
    collection_out,
)
from iclip.domains.collections.service import CollectionService, Scope
from iclip.domains.identity.public import Principal, require_permission


def create_collections_router(service: CollectionService) -> APIRouter:
    router = APIRouter(prefix="/collections", tags=["collections"])

    @router.post("", response_model=CollectionEnvelope, status_code=201)
    async def create_collection(
        body: CollectionIn,
        principal: Annotated[Principal, Depends(require_permission("collections:write"))],
    ) -> CollectionEnvelope:
        collection = await service.create(principal, name=body.name)
        return CollectionEnvelope(collection=collection_out(collection))

    @router.get("", response_model=CollectionsPageOut)
    async def list_collections(
        principal: Annotated[Principal, Depends(require_permission("collections:read"))],
        scope: Scope = "me",
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> CollectionsPageOut:
        found = await service.list_recent(principal, scope=scope, limit=limit, offset=offset)
        return CollectionsPageOut(items=[collection_out(item) for item in found])

    @router.get("/{collection_id}", response_model=CollectionEnvelope)
    async def read_collection(
        collection_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("collections:read"))],
    ) -> CollectionEnvelope:
        collection = await service.get(principal, collection_id)
        return CollectionEnvelope(collection=collection_out(collection))

    @router.patch("/{collection_id}", response_model=CollectionEnvelope)
    async def rename_collection(
        collection_id: uuid.UUID,
        body: CollectionIn,
        principal: Annotated[Principal, Depends(require_permission("collections:write"))],
    ) -> CollectionEnvelope:
        collection = await service.rename(principal, collection_id, name=body.name)
        return CollectionEnvelope(collection=collection_out(collection))

    @router.delete("/{collection_id}", status_code=204)
    async def delete_collection(
        collection_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("collections:write"))],
    ) -> Response:
        await service.delete(principal, collection_id)
        return Response(status_code=204)

    return router


__all__ = ["create_collections_router"]
