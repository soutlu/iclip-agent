"""生成任务状态跳转落库后发 ``event.generation.changed``；仓储实现与连接管理经组合根适配。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from iclip.domains.agents.transcript_api import LiveConnections
from iclip.domains.generation.models import (
    GenerationJob,
    GenerationKind,
    GenerationStatus,
    InFlightPhase,
    Inheritance,
)
from iclip.domains.generation.repository import GenerationRepository


class AnnouncingGenerationRepository:
    """包在 ``GenerationRepository`` 外面：每次业务状态跳转写成功，就向属主广播一帧。

    受理落 ``pending`` 也算一跳，agent 发起的出图才会在页面上冒出来。``record_progress`` 只更新
    provider 原始状态、不改业务状态，不发帧，否则每次轮询上游都会喊一声——clip 的阶段词也走它，
    所以最多晚一轮轮询才被看到；``mark_failed`` 与 ``mark_completed`` 带状态守卫没命中时返回
    None，也不发帧。"""

    def __init__(self, inner: GenerationRepository, live: LiveConnections) -> None:
        self._inner = inner
        self._live = live

    async def create(self, job: GenerationJob) -> GenerationJob:
        return self._announce(await self._inner.create(job))

    async def get(
        self, job_id: uuid.UUID, *, owner: uuid.UUID | None, inherited: Inheritance = ()
    ) -> GenerationJob:
        return await self._inner.get(job_id, owner=owner, inherited=inherited)

    async def list_for_owner(
        self,
        *,
        owner: uuid.UUID | None,
        limit: int,
        conversation_id: uuid.UUID | None = None,
        kind: GenerationKind | None = None,
        metadata: Mapping[str, Any] | None = None,
        task_id: uuid.UUID | None = None,
        root_job_id: uuid.UUID | None = None,
        before: uuid.UUID | None = None,
        inherited: Inheritance = (),
    ) -> tuple[GenerationJob, ...]:
        return await self._inner.list_for_owner(
            owner=owner,
            limit=limit,
            conversation_id=conversation_id,
            kind=kind,
            metadata=metadata,
            task_id=task_id,
            root_job_id=root_job_id,
            before=before,
            inherited=inherited,
        )

    async def mark_submitting(self, job_id: uuid.UUID) -> GenerationJob:
        return self._announce(await self._inner.mark_submitting(job_id))

    async def mark_submitted(
        self,
        job_id: uuid.UUID,
        *,
        provider_task_id: str,
        provider_status: str,
        provider_snapshot: dict[str, Any],
    ) -> GenerationJob:
        return self._announce(
            await self._inner.mark_submitted(
                job_id,
                provider_task_id=provider_task_id,
                provider_status=provider_status,
                provider_snapshot=provider_snapshot,
            )
        )

    async def mark_completed(
        self,
        job_id: uuid.UUID,
        *,
        output_url: str,
        provider_status: str,
        provider_snapshot: dict[str, Any],
        provider_task_id: str | None = None,
        watermark_output_url: str | None = None,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        job = await self._inner.mark_completed(
            job_id,
            output_url=output_url,
            provider_status=provider_status,
            provider_snapshot=provider_snapshot,
            provider_task_id=provider_task_id,
            watermark_output_url=watermark_output_url,
            only_if_status=only_if_status,
        )
        return None if job is None else self._announce(job)

    async def mark_failed(
        self,
        job_id: uuid.UUID,
        *,
        error_code: str,
        error_message: str,
        provider_status: str | None = None,
        provider_snapshot: dict[str, Any] | None = None,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        job = await self._inner.mark_failed(
            job_id,
            error_code=error_code,
            error_message=error_message,
            provider_status=provider_status,
            provider_snapshot=provider_snapshot,
            only_if_status=only_if_status,
        )
        return None if job is None else self._announce(job)

    async def record_progress(
        self,
        job_id: uuid.UUID,
        *,
        provider_status: str,
        provider_snapshot: dict[str, Any] | None = None,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        return await self._inner.record_progress(
            job_id,
            provider_status=provider_status,
            provider_snapshot=provider_snapshot,
            only_if_status=only_if_status,
        )

    async def in_flight_by_conversation(
        self, conversation_ids: Sequence[uuid.UUID], *, kind: GenerationKind
    ) -> Mapping[uuid.UUID, InFlightPhase]:
        return await self._inner.in_flight_by_conversation(conversation_ids, kind=kind)

    def _announce(self, job: GenerationJob) -> GenerationJob:
        self._live.announce_generation_changed(
            job.owner_user_id,
            job.conversation_id,
            job_id=job.id,
            kind=job.kind,
            status=job.status,
            metadata=job.metadata,
        )
        return job


__all__ = ["AnnouncingGenerationRepository"]
