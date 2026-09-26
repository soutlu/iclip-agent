"""generation 测试替身与构造器。"""

from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from procrastinate.testing import InMemoryConnector

from iclip.config import (
    ImageGenerationSection,
    ImageModelSection,
    MediaGenerationSection,
    RuntimeConfig,
    VideoGenerationSection,
)
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationKind,
    GenerationOperation,
    GenerationStatus,
    InFlightPhase,
    Inheritance,
    inherited_through,
)
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
)
from iclip.domains.generation.queue import GenerationQueue, GenerationQueueSettings, ProviderLane
from iclip.domains.generation.schemas import (
    KIND_IMAGE,
    KIND_VIDEO,
    OPERATION_CUT,
    OPERATION_UPLOAD,
    GenerationRequest,
    ImageGenerationIn,
    VideoComposeRequest,
    VideoGenerationIn,
)
from iclip.domains.identity.public import Principal
from iclip.platform.object_store.store import StoredObject
from tests.helpers.app import make_runtime_config

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


def edit_request(**overrides: Any) -> VideoGenerationIn:
    """编辑段落库的请求：参考视频留空，由服务端提交上游前按区间切。"""

    return video_request(**{"seconds": -1, "aspect_ratio": None, **overrides})


def compose_request(**overrides: Any) -> VideoComposeRequest:
    """默认是一次合成：基底前段、编辑段产物整条、基底后段取到结尾。"""

    fields: dict[str, Any] = {
        "segments": [
            {"url": "https://example.com/base.mp4", "start": 0, "end": 1},
            {"url": "https://example.com/edited.mp4", "start": 0},
            {"url": "https://example.com/base.mp4", "start": 4},
        ],
        "user_name": "luke",
    }
    fields.update(overrides)
    return VideoComposeRequest(**fields)


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
    kind: GenerationKind | None = None,
    operation: GenerationOperation | None = None,
    status: GenerationStatus = STATUS_PENDING,
    provider: str | None = None,
    provider_task_id: str | None = None,
    submitted_at: datetime | None = None,
    created_at: datetime | None = None,
    finished_at: datetime | None = None,
    owner_user_id: uuid.UUID | None = None,
    conversation_id: uuid.UUID | None = None,
    metadata: dict[str, Any] | None = None,
    task_id: uuid.UUID | None = None,
    shot_index: int | None = None,
    root_job_id: uuid.UUID | None = None,
    source_job_id: uuid.UUID | None = None,
    source_url: str | None = None,
    range_start_ms: int | None = None,
    range_end_ms: int | None = None,
    output_url: str | None = None,
    watermark_output_url: str | None = None,
    duration_ms: int | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> GenerationJob:
    """kind 与 operation 随请求定，默认是一条出片；只有没有请求的行（切图、上传）才显式给这两个。"""

    now = datetime.now(UTC)
    payload: GenerationRequest | None
    if kind is None and operation is None:
        payload = request or video_request()
        row_kind, row_operation = payload.kind, payload.operation
    elif request is None and kind is not None and operation is not None:
        payload, row_kind, row_operation = None, kind, operation
    else:
        raise AssertionError("kind 与 operation 只给没有请求的行，且要一起给")
    default_provider = (
        row_operation
        if payload is None
        else FAKE_VIDEO_PROVIDER
        if row_kind == KIND_VIDEO
        else FAKE_IMAGE_PROVIDER
    )
    return GenerationJob(
        id=uuid.uuid4(),
        owner_user_id=owner_user_id or uuid.uuid4(),
        api_key_id=None,
        conversation_id=conversation_id,
        metadata=metadata,
        task_id=task_id,
        shot_index=shot_index,
        root_job_id=root_job_id,
        source_job_id=source_job_id,
        source_url=source_url,
        range_start_ms=range_start_ms,
        range_end_ms=range_end_ms,
        kind=row_kind,
        operation=row_operation,
        provider=provider or default_provider,
        request=payload,
        status=status,
        provider_task_id=provider_task_id,
        provider_status=None,
        output_url=output_url,
        watermark_output_url=watermark_output_url,
        duration_ms=duration_ms,
        error_code=error_code,
        error_message=error_message,
        created_at=created_at or now,
        submitted_at=submitted_at,
        finished_at=finished_at,
    )


def stored_request(job: GenerationJob) -> GenerationRequest:
    """调模型或本地拼接的记录落库的请求；切图与上传没有请求，拿它们来取是用例写错了。"""

    assert job.request is not None, f"{job.kind} / {job.operation} 没有请求"
    return job.request


def make_edit(base: GenerationJob, **fields: Any) -> GenerationJob:
    """基于 ``base`` 的一条编辑段：来源是基底，原作与镜号随基底（基底是出片就是它自己），区间默认 1–4 秒。"""

    fields.setdefault("range_start_ms", 1000)
    fields.setdefault("range_end_ms", 4000)
    fields.setdefault("shot_index", base.shot_index)
    return make_job(
        edit_request(),
        source_job_id=base.id,
        root_job_id=base.root_job_id or base.id,
        **fields,
    )


def make_composite(edit: GenerationJob, **fields: Any) -> GenerationJob:
    """合成 ``edit`` 的一条记录：来源是编辑段，原作与镜号随它，执行方是本地 ffmpeg。"""

    fields.setdefault("provider", "ffmpeg")
    fields.setdefault("shot_index", edit.shot_index)
    return make_job(
        compose_request(), source_job_id=edit.id, root_job_id=edit.root_job_id, **fields
    )


def make_upload(*, kind: GenerationKind = KIND_IMAGE, **fields: Any) -> GenerationJob:
    """一条上传：创建即完成，没有请求与来源，不挂对话。"""

    fields.setdefault("status", STATUS_COMPLETED)
    fields.setdefault("finished_at", datetime.now(UTC))
    fields.setdefault("output_url", f"https://cdn.test/iclip/agent/uploads/{uuid.uuid4()}.png")
    return make_job(kind=kind, operation=OPERATION_UPLOAD, **fields)


def make_cut(grid: GenerationJob, **fields: Any) -> GenerationJob:
    """从宫格 ``grid`` 切出来的一格：来源是宫格，对话与属主随它，创建即完成。"""

    fields.setdefault("status", STATUS_COMPLETED)
    fields.setdefault("finished_at", datetime.now(UTC))
    fields.setdefault(
        "output_url", f"https://cdn.test/shot-frames/{grid.id}/out/{uuid.uuid4()}.jpg"
    )
    fields.setdefault("conversation_id", grid.conversation_id)
    fields.setdefault("owner_user_id", grid.owner_user_id)
    return make_job(kind=KIND_IMAGE, operation=OPERATION_CUT, source_job_id=grid.id, **fields)


class InMemoryGenerationRepository:
    """GenerationRepository 内存替身，仅处理状态跳转与列表筛选；排期由队列负责。"""

    def __init__(self, jobs: list[GenerationJob] | None = None) -> None:
        self.jobs: dict[uuid.UUID, GenerationJob] = {job.id: job for job in jobs or []}

    async def create(self, job: GenerationJob) -> GenerationJob:
        self.jobs[job.id] = job
        return job

    async def create_settled(self, jobs: Sequence[GenerationJob]) -> tuple[GenerationJob, ...]:
        from dataclasses import replace

        now = datetime.now(UTC)
        created: list[GenerationJob] = []
        for job in jobs:
            if job.id in self.jobs:
                continue
            stored = replace(job, created_at=now, finished_at=now)
            self.jobs[job.id] = stored
            created.append(stored)
        return tuple(created)

    async def find_image_by_output(
        self,
        output_url: str,
        *,
        owner: uuid.UUID | None,
        conversation_id: uuid.UUID | None,
        inherited: Inheritance = (),
        operation: GenerationOperation | None = None,
    ) -> GenerationJob | None:
        found = [
            job
            for job in self.jobs.values()
            if job.kind == KIND_IMAGE
            and job.status == STATUS_COMPLETED
            and job.output_url == output_url
            and (operation is None or job.operation == operation)
            and (
                (
                    (owner is None or job.owner_user_id == owner)
                    and job.conversation_id == conversation_id
                )
                or inherited_through(job, inherited)
            )
        ]
        return min(found, key=lambda job: (job.created_at, job.id), default=None)

    async def output_urls(self, ids: Collection[uuid.UUID]) -> Mapping[uuid.UUID, str]:
        urls: dict[uuid.UUID, str] = {}
        for job_id in ids:
            job = self.jobs.get(job_id)
            if job is not None and job.output_url is not None:
                urls[job_id] = job.output_url
        return urls

    async def get(
        self, job_id: uuid.UUID, *, owner: uuid.UUID | None, inherited: Inheritance = ()
    ) -> GenerationJob:
        from iclip.common.errors import NotFound

        job = self.jobs.get(job_id)
        if job is None or not (
            owner is None or job.owner_user_id == owner or inherited_through(job, inherited)
        ):
            raise NotFound(f"没有这次生成: {job_id}")
        return job

    async def list_for_owner(
        self,
        *,
        owner: uuid.UUID | None,
        limit: int,
        conversation_id: uuid.UUID | None = None,
        kind: GenerationKind | None = None,
        operation: GenerationOperation | None = None,
        metadata: Mapping[str, Any] | None = None,
        task_id: uuid.UUID | None = None,
        shot_index: int | None = None,
        root_job_id: uuid.UUID | None = None,
        source_job_id: uuid.UUID | None = None,
        before: uuid.UUID | None = None,
        inherited: Inheritance = (),
    ) -> tuple[GenerationJob, ...]:
        rows = [
            job
            for job in self.jobs.values()
            if (
                (
                    (owner is None or job.owner_user_id == owner)
                    and (conversation_id is None or job.conversation_id == conversation_id)
                )
                or inherited_through(job, inherited)
            )
            and (task_id is None or job.task_id == task_id)
            and (shot_index is None or job.shot_index == shot_index)
            and (root_job_id is None or job.root_job_id == root_job_id)
            and (source_job_id is None or job.source_job_id == source_job_id)
        ]
        rows = [
            job
            for job in rows
            if (kind is None or job.kind == kind)
            and (operation is None or job.operation == operation)
        ]
        if metadata is not None:
            # 顶层键相等。Postgres 的 @> 对嵌套对象是递归包含，分镜页的坐标是平的，这里不模拟嵌套。
            rows = [
                job
                for job in rows
                if job.metadata is not None
                and all(job.metadata.get(key) == value for key, value in metadata.items())
            ]
        if before is not None:
            anchor = await self.get(before, owner=owner, inherited=inherited)
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
    ) -> GenerationJob:
        return self._replace(
            job_id,
            status=STATUS_SUBMITTED,
            provider_task_id=provider_task_id,
            provider_status=provider_status,
            submitted_at=datetime.now(UTC),
        )

    async def mark_completed(
        self,
        job_id: uuid.UUID,
        *,
        output_url: str,
        provider_status: str,
        provider_task_id: str | None = None,
        watermark_output_url: str | None = None,
        duration_ms: int | None = None,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        current = self.jobs[job_id]
        if only_if_status is not None and current.status != only_if_status:
            return None
        return self._replace(
            job_id,
            status=STATUS_COMPLETED,
            output_url=output_url,
            watermark_output_url=watermark_output_url,
            provider_status=provider_status,
            provider_task_id=provider_task_id or current.provider_task_id,
            duration_ms=current.duration_ms if duration_ms is None else duration_ms,
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
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        if only_if_status is not None and self.jobs[job_id].status != only_if_status:
            return None
        extra: dict[str, Any] = {}
        if provider_status is not None:
            extra["provider_status"] = provider_status
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
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        if only_if_status is not None and self.jobs[job_id].status != only_if_status:
            return None
        return self._replace(job_id, provider_status=provider_status)

    async def record_reference_cut(
        self,
        job_id: uuid.UUID,
        *,
        range_start_ms: int,
        range_end_ms: int,
        only_if_status: GenerationStatus,
    ) -> GenerationJob | None:
        if self.jobs[job_id].status != only_if_status:
            return None
        return self._replace(
            job_id,
            range_start_ms=range_start_ms,
            range_end_ms=range_end_ms,
            provider_status=None,
        )

    async def in_flight_by_conversation(
        self, conversation_ids: Sequence[uuid.UUID], *, kind: GenerationKind
    ) -> Mapping[uuid.UUID, InFlightPhase]:
        """在途汇总的优先级规则只由 Postgres 仓储的集成测试覆盖，替身不复刻。"""

        raise AssertionError("unit 层不走在途汇总")

    def _replace(self, job_id: uuid.UUID, **values: Any) -> GenerationJob:
        from dataclasses import replace

        updated = replace(self.jobs[job_id], **values)
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


QUEUE_SETTINGS = GenerationQueueSettings(
    poll_interval_seconds=5, error_retry_seconds=30, job_timeout_seconds=3600
)


def build_queue(
    repo: InMemoryGenerationRepository,
    *,
    video: ScriptedProvider | None = None,
    image: ScriptedProvider | None = None,
    lanes: tuple[ProviderLane, ...] | None = None,
) -> tuple[GenerationQueue, InMemoryConnector]:
    """两家替身各占一条 lane，名字与 make_job 落到 provider 列上的值一致。"""

    if lanes is None:
        video_double = video or ScriptedProvider()
        video_double.provider_name = FAKE_VIDEO_PROVIDER
        image_double = image or ScriptedProvider()
        image_double.provider_name = FAKE_IMAGE_PROVIDER
        lanes = (ProviderLane(video_double, 1), ProviderLane(image_double, 1))
    connector = InMemoryConnector()
    queue = GenerationQueue(
        repo,
        lanes=lanes,
        connector=connector,
        settings=QUEUE_SETTINGS,
    )
    return queue, connector


MEDIA_ENVS = {
    "OSS_BUCKET": "iclip-test",
    "OSS_ENDPOINT": "oss-cn-hangzhou.aliyuncs.com",
    "OSS_ACCESS_KEY_ID": "ak",
    "OSS_ACCESS_KEY_SECRET": "sk",
    "OSS_PUBLIC_URL_BASE": "https://cdn.example.test",
    "VIDEO_SUBMIT_URL": "https://video.test/submit",
    "VIDEO_STATUS_BASE_URL": "https://video.test/status",
    "VIDEO_API_KEY": "vk",
    "IMAGE_API_BASE": "https://image.test/atlas",
}
"""开媒体生成要的环境变量；地址都是替身，装配期不外呼。"""


def config_with_media() -> RuntimeConfig:
    """测试运行配置外加媒体生成段：视频一个模型，图片一家。"""

    return make_runtime_config().model_copy(
        update={
            "media_generation": MediaGenerationSection(
                video=VideoGenerationSection(model="seedance", allowed_models=("seedance",)),
                image=ImageGenerationSection(
                    env="test",
                    default="nano_banana_pro",
                    models={
                        "nano_banana_pro": ImageModelSection(route="nano-banana-pro", concurrency=4)
                    },
                ),
            ),
        }
    )


class FixedLineage:
    """ConversationLineage 替身：各对话的继承边界对与主体读不读得到都预先写死。"""

    def __init__(
        self,
        ancestry: Mapping[uuid.UUID, Inheritance] | None = None,
        *,
        readable: bool = True,
    ) -> None:
        self._ancestry = dict(ancestry or {})
        self._readable = readable

    async def ancestry(self, conversation_id: uuid.UUID) -> Inheritance:
        return self._ancestry.get(conversation_id, ())

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool:
        return self._readable


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

    def sign_put(self, *, object_key: str, headers: Mapping[str, str]) -> str:
        return f"{self.base}/{object_key}?signed-for={headers['Content-Type']}"

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        found = [key for key in self.objects if key.startswith(prefix)]
        if not found:
            return None
        content, content_type = self.objects[found[0]]
        return StoredObject(object_key=found[0], content_type=content_type, size_bytes=len(content))

    def public_url(self, object_key: str) -> str:
        return f"{self.base}/{object_key}"


__all__ = [
    "MEDIA_ENVS",
    "QUEUE_SETTINGS",
    "FixedLineage",
    "InMemoryGenerationRepository",
    "MemoryObjectStore",
    "ScriptedProvider",
    "build_queue",
    "compose_request",
    "config_with_media",
    "edit_request",
    "image_request",
    "make_composite",
    "make_cut",
    "make_edit",
    "make_job",
    "make_upload",
    "stored_request",
    "video_request",
]
