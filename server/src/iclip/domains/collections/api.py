"""合集 HTTP 端点。读取受属主范围限制，治理者可查询全部；写入仅允许属主或治理者。"""

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
