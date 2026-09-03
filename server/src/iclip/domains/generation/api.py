"""媒体生成的 HTTP 面。

提交返回 202：这时候一行 ``pending`` 已经落库，但还没碰过 provider。客户端拿着
``id`` 去查状态。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from iclip.domains.generation.schemas import (
    GenerationEnvelope,
    GenerationIn,
    GenerationsPageOut,
    generation_out,
)
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal, require_permission


def create_generations_router(service: GenerationService) -> APIRouter:
    router = APIRouter(prefix="/generations")

    @router.post("", response_model=GenerationEnvelope, status_code=202)
    async def submit(
        body: GenerationIn,
        principal: Annotated[Principal, Depends(require_permission("generation:submit"))],
    ) -> GenerationEnvelope:
        job = await service.submit(principal, body)
        return GenerationEnvelope(generation=generation_out(job))

    @router.get("", response_model=GenerationsPageOut)
    async def list_generations(
        principal: Annotated[Principal, Depends(require_permission("generation:read"))],
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        conversation_id: Annotated[uuid.UUID | None, Query(alias="conversationId")] = None,
    ) -> GenerationsPageOut:
        """给了 ``conversationId`` 就只列那段对话下面的生成记录，可见性口径不变。"""

        jobs = await service.list_recent(principal, limit=limit, conversation_id=conversation_id)
        return GenerationsPageOut(items=[generation_out(job) for job in jobs])

    @router.get("/{job_id}", response_model=GenerationEnvelope)
    async def get_generation(
        job_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_permission("generation:read"))],
    ) -> GenerationEnvelope:
        job = await service.get(principal, job_id)
        return GenerationEnvelope(generation=generation_out(job))

    return router


__all__ = ["create_generations_router"]
