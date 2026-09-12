"""generation 测试替身与构造器。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
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
    KIND_VIDEO,
    GenerationRequest,
    ImageGenerationIn,
    VideoGenerationIn,
)
from iclip.platform.object_store.oss import StoredObject

FAKE_VIDEO_PROVIDER = "video_fake"
FAKE_IMAGE_PROVIDER = "image_fake"
"""替身 provider 的名字。队列按任务行上的 provider 列查表，替身与 make_job 得用同一套。"""


def video_request(**overrides: Any) -> VideoGenerationIn:
    fields: dict[str, Any] = {
        "model": "moyu-seedance-2-5",
        "prompt": "一只猫跳上窗台",
        "user_name": "luke",
        "aspect_ratio": "16:9",
        "seconds": 5,
    }
    fields.update(overrides)
    return VideoGenerationIn(**fields)


SHOT_IMAGE_URLS = ["https://example.com/a.png", "https://example.com/b.png"]

SHOT_PROMPT = "人物保持一致。\n\n[0–6秒｜镜头1] 走向镜头 @Image1，停下 @Image2。\n不要生成字幕，不要生成背景音乐。"
"""与 web/src/features/storyboard/storyboard.api.test.ts 里的镜头组拼出的正文一字不差。"""


def video_shot(**overrides: Any) -> dict[str, Any]:
    """一段结构化镜头组的请求体，默认值与前端那份单测夹具相同。"""

    shot: dict[str, Any] = {
        "global_settings": "人物保持一致。",
        "timeline": [
            {
                "timestamps": [0, 6],
                "prompt": "走向镜头 @Image1，停下 @Image2。",
                "image_indexes": [1, 2],
            }
        ],
    }
    shot.update(overrides)
    return shot


def image_request(**overrides: Any) -> ImageGenerationIn:
    fields: dict[str, Any] = {
        "prompt": "一只猫的正面特写",
        "user_name": "luke",
        "aspect_ratio": "1:1",
        "resolution": "1k",
    }
    fields.update(overrides)
    return ImageGenerationIn(**fields)


def make_job(
    request: GenerationRequest | None = None,
    *,
    status: GenerationStatus = STATUS_PENDING,
    provider: str | None = None,
    provider_task_id: str | None = None,
    submitted_at: datetime | None = None,
    created_at: datetime | None = None,
    owner_user_id: uuid.UUID | None = None,
    conversation_id: uuid.UUID | None = None,
    metadata: dict[str, Any] | None = None,
    task_id: uuid.UUID | None = None,
    output_url: str | None = None,
    watermark_output_url: str | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> GenerationJob:
    now = datetime.now(UTC)
    payload = request or video_request()
    return GenerationJob(
        id=uuid.uuid4(),
        owner_user_id=owner_user_id or uuid.uuid4(),
        api_key_id=None,
        conversation_id=conversation_id,
        metadata=metadata,
        task_id=task_id,
        kind=payload.kind,
        provider=provider
        or (FAKE_VIDEO_PROVIDER if payload.kind == KIND_VIDEO else FAKE_IMAGE_PROVIDER),
        request=payload,
        status=status,
        provider_task_id=provider_task_id,
        provider_status=None,
        provider_snapshot=None,
        output_url=output_url,
        watermark_output_url=watermark_output_url,
        error_code=error_code,
        error_message=error_message,
        created_at=created_at or now,
        updated_at=now,
        submitted_at=submitted_at,
        finished_at=None,
    )


class InMemoryGenerationRepository:
    """GenerationRepository 内存替身，仅处理状态跳转；排期由队列负责。"""

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
        self,
        *,
        owner: uuid.UUID | None,
        limit: int,
        conversation_id: uuid.UUID | None = None,
        kind: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        task_id: uuid.UUID | None = None,
        before: uuid.UUID | None = None,
    ) -> tuple[GenerationJob, ...]:
        rows = [
            job
            for job in self.jobs.values()
            if (owner is None or job.owner_user_id == owner)
            and (conversation_id is None or job.conversation_id == conversation_id)
            and (task_id is None or job.task_id == task_id)
        ]
        rows = [job for job in rows if kind is None or job.kind == kind]
        if metadata is not None:
            # 顶层键相等。Postgres 的 @> 对嵌套对象是递归包含，分镜页的坐标是平的，这里不模拟嵌套。
            rows = [
                job
                for job in rows
                if job.metadata is not None
                and all(job.metadata.get(key) == value for key, value in metadata.items())
            ]
        if before is not None:
            anchor = await self.get(before, owner=owner)
            rows = [
                job for job in rows if (job.created_at, job.id) < (anchor.created_at, anchor.id)
            ]
        rows.sort(key=lambda job: (job.created_at, job.id), reverse=True)
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
        watermark_output_url: str | None = None,
    ) -> GenerationJob:
        current = self.jobs[job_id]
        return self._replace(
            job_id,
            status=STATUS_COMPLETED,
            output_url=output_url,
            watermark_output_url=watermark_output_url,
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
    """按预设顺序响应并记录调用的 provider 替身。"""

    def __init__(
        self,
        *,
        name: str = "fake",
        submission: ProviderSubmission | Exception | None = None,
        progress: ProviderProgress | Exception | None = None,
    ) -> None:
        self.provider_name = name
        """可写：装配替身时按那条 lane 该叫什么名字改。"""
        self._submission = submission
        self._progress = progress
        self.submit_calls: list[uuid.UUID] = []
        self.poll_calls: list[uuid.UUID] = []

    @property
    def name(self) -> str:
        return self.provider_name

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
    """PublicBucket 内存替身。

    sign_put 不产生可访问的地址；测试通过 put_public_object 模拟直传完成。
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
