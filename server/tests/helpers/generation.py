"""generation 测试替身与构造器。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationStatus,
)
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
)
from iclip.domains.generation.schemas import (
    GenerationRequest,
    ImageGenerationIn,
    VideoGenerationIn,
)
from iclip.platform.object_store.oss import StoredObject


def video_request(**overrides: Any) -> VideoGenerationIn:
    fields: dict[str, Any] = {
        "prompt": "一只猫跳上窗台",
        "aspect_ratio": "16:9",
        "duration_seconds": 5,
    }
    fields.update(overrides)
    return VideoGenerationIn(**fields)


def image_request(**overrides: Any) -> ImageGenerationIn:
    fields: dict[str, Any] = {
        "prompt": "一只猫的正面特写",
        "aspect_ratio": "1:1",
        "resolution": "1k",
    }
    fields.update(overrides)
    return ImageGenerationIn(**fields)


def make_job(
    request: GenerationRequest | None = None,
    *,
    status: GenerationStatus = STATUS_PENDING,
    provider_task_id: str | None = None,
    submitted_at: datetime | None = None,
    created_at: datetime | None = None,
    owner_user_id: uuid.UUID | None = None,
) -> GenerationJob:
    now = datetime.now(UTC)
    payload = request or video_request()
    return GenerationJob(
        id=uuid.uuid4(),
        owner_user_id=owner_user_id or uuid.uuid4(),
        api_key_id=None,
        kind=payload.kind,
        provider="fake",
        request=payload,
        status=status,
        provider_task_id=provider_task_id,
        provider_status=None,
        provider_snapshot=None,
        output_url=None,
        error_code=None,
        error_message=None,
        created_at=created_at or now,
        updated_at=now,
        submitted_at=submitted_at,
        finished_at=None,
    )


class InMemoryGenerationRepository:
    """``GenerationRepository`` 的内存替身。

    只有状态跳转，没有排队——排期在 procrastinate 那边（见 ``queue.py``）。
    """

    def __init__(self, jobs: list[GenerationJob] | None = None) -> None:
        self.jobs: dict[uuid.UUID, GenerationJob] = {job.id: job for job in jobs or []}

    async def create(self, job: GenerationJob) -> GenerationJob:
        self.jobs[job.id] = job
        return job

    async def get(self, job_id: uuid.UUID, *, owner: uuid.UUID | None) -> GenerationJob:
        from iclip.common.errors import NotFound

        job = self.jobs.get(job_id)
        if job is None or (owner is not None and job.owner_user_id != owner):
            raise NotFound(f"没有这次生成: {job_id}")
        return job

    async def list_for_owner(
        self, *, owner: uuid.UUID | None, limit: int
    ) -> tuple[GenerationJob, ...]:
        rows = [job for job in self.jobs.values() if owner is None or job.owner_user_id == owner]
        rows.sort(key=lambda job: job.created_at, reverse=True)
        return tuple(rows[:limit])

    async def mark_submitting(self, job_id: uuid.UUID) -> GenerationJob:
        return self._replace(job_id, status=STATUS_SUBMITTING)

    async def mark_submitted(
        self,
        job_id: uuid.UUID,
        *,
        provider_task_id: str,
        provider_status: str,
        provider_snapshot: dict[str, Any],
    ) -> GenerationJob:
        return self._replace(
            job_id,
            status=STATUS_SUBMITTED,
            provider_task_id=provider_task_id,
            provider_status=provider_status,
            provider_snapshot=provider_snapshot,
            submitted_at=datetime.now(UTC),
        )

    async def mark_completed(
        self,
        job_id: uuid.UUID,
        *,
        output_url: str,
        provider_status: str,
        provider_snapshot: dict[str, Any],
        provider_task_id: str | None = None,
    ) -> GenerationJob:
        current = self.jobs[job_id]
        return self._replace(
            job_id,
            status=STATUS_COMPLETED,
            output_url=output_url,
            provider_status=provider_status,
            provider_snapshot=provider_snapshot,
            provider_task_id=provider_task_id or current.provider_task_id,
            submitted_at=current.submitted_at or datetime.now(UTC),
            finished_at=datetime.now(UTC),
        )

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
        if only_if_status is not None and self.jobs[job_id].status != only_if_status:
            return None
        extra: dict[str, Any] = {}
        if provider_status is not None:
            extra["provider_status"] = provider_status
        if provider_snapshot is not None:
            extra["provider_snapshot"] = provider_snapshot
        return self._replace(
            job_id,
            status=STATUS_FAILED,
            error_code=error_code,
            error_message=error_message,
            finished_at=datetime.now(UTC),
            **extra,
        )

    async def record_progress(
        self,
        job_id: uuid.UUID,
        *,
        provider_status: str,
        provider_snapshot: dict[str, Any],
    ) -> GenerationJob:
        return self._replace(
            job_id,
            provider_status=provider_status,
            provider_snapshot=provider_snapshot,
        )

    def _replace(self, job_id: uuid.UUID, **values: Any) -> GenerationJob:
        from dataclasses import replace

        updated = replace(self.jobs[job_id], updated_at=datetime.now(UTC), **values)
        self.jobs[job_id] = updated
        return updated


class ScriptedProvider:
    """按剧本回应的 provider 替身，记录被调用了几次。"""

    def __init__(
        self,
        *,
        name: str = "fake",
        submission: ProviderSubmission | Exception | None = None,
        progress: ProviderProgress | Exception | None = None,
    ) -> None:
        self._name = name
        self._submission = submission
        self._progress = progress
        self.submit_calls: list[uuid.UUID] = []
        self.poll_calls: list[uuid.UUID] = []

    @property
    def name(self) -> str:
        return self._name

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        self.submit_calls.append(job.id)
        if isinstance(self._submission, Exception):
            raise self._submission
        if self._submission is None:
            raise ProviderError("剧本没写提交", code="NO_SCRIPT", retryable=False)
        return self._submission

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        self.poll_calls.append(job.id)
        if isinstance(self._progress, Exception):
            raise self._progress
        if self._progress is None:
            raise ProviderError("剧本没写轮询", code="NO_SCRIPT", retryable=False)
        return self._progress


class MemoryObjectStore:
    """``PublicBucket`` 的内存替身：写字节、签直传、按前缀找回来。

    直传那一半也在这里，是因为组合根注入的是整只桶——它同时喂给生成与素材两侧。
    ``sign_put`` 返回的地址不指向任何真东西，测试直接调 ``put_public_object`` 模拟
    「浏览器传上去了」。
    """

    def __init__(self, *, base: str = "https://cdn.example.test") -> None:
        self.base = base
        self.objects: dict[str, tuple[bytes, str]] = {}

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        self.objects[object_key] = (content, content_type)
        return self.public_url(object_key)

    def sign_put(self, *, object_key: str, content_type: str) -> str:
        return f"{self.base}/{object_key}?signed-for={content_type}"

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        found = [key for key in self.objects if key.startswith(prefix)]
        if not found:
            return None
        content, content_type = self.objects[found[0]]
        return StoredObject(object_key=found[0], content_type=content_type, size_bytes=len(content))

    def public_url(self, object_key: str) -> str:
        return f"{self.base}/{object_key}"


__all__ = [
    "InMemoryGenerationRepository",
    "MemoryObjectStore",
    "ScriptedProvider",
    "image_request",
    "make_job",
    "video_request",
]
