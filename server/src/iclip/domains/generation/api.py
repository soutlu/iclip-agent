"""媒体生成 HTTP 端点。提交返回 202，此时 pending 记录已落库，Provider 调用由后台执行。"""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

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
        kind: Literal["image", "video"] | None = None,
        artifact_path: Annotated[str | None, Query(alias="artifactPath", max_length=500)] = None,
        shot_index: Annotated[int | None, Query(alias="shotIndex", ge=1)] = None,
        frame_number: Annotated[int | None, Query(alias="frameNumber", ge=1)] = None,
        before: uuid.UUID | None = None,
    ) -> GenerationsPageOut:
        """给了 ``conversationId`` 就只列那段对话下面的生成记录，可见性口径不变。"""

        jobs = await service.list_recent(
            principal,
            limit=limit,
            conversation_id=conversation_id,
            kind=kind,
            artifact_path=artifact_path,
            shot_index=shot_index,
            frame_number=frame_number,
            before=before,
        )
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
