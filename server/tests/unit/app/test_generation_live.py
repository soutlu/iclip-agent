"""生成任务状态跳转经包装仓库广播为全局帧。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any

from iclip.app.generation_live import AnnouncingGenerationRepository
from iclip.domains.agents.transcript_api import LiveConnections
from iclip.domains.generation.models import STATUS_SUBMITTED, STATUS_SUBMITTING
from tests.helpers.generation import InMemoryGenerationRepository, image_request, make_job

Announced = tuple[uuid.UUID, uuid.UUID | None, uuid.UUID, str, str, Mapping[str, Any] | None]

SHOT = {"path": "video_shot.json", "shot": 2}
FRAME = {"path": "video_shot.json", "shot": 1, "frame": 3}


class _RecordingConnections(LiveConnections):
    """记录生成任务帧，不创建 WS 连接。"""

    def __init__(self) -> None:
        super().__init__()
        self.announced: list[Announced] = []

    def announce_generation_changed(
        self,
        owner: uuid.UUID,
        conversation_id: uuid.UUID | None,
        *,
        job_id: uuid.UUID,
        kind: str,
        status: str,
        metadata: Mapping[str, Any] | None,
    ) -> None:
        self.announced.append((owner, conversation_id, job_id, kind, status, metadata))


async def test_every_status_transition_of_a_video_job_is_announced_to_its_owner() -> None:
    live = _RecordingConnections()
    repo = AnnouncingGenerationRepository(InMemoryGenerationRepository(), live)
    owner, conversation_id = uuid.uuid4(), uuid.uuid4()
    job = make_job(owner_user_id=owner, conversation_id=conversation_id, metadata=SHOT)

    await repo.create(job)
    await repo.mark_submitting(job.id)
    await repo.mark_submitted(
        job.id, provider_task_id="t-1", provider_status="queued", provider_snapshot={}
    )
    await repo.record_progress(job.id, provider_status="running", provider_snapshot={})
    await repo.mark_completed(
        job.id,
        output_url="https://cdn.test/take.mp4",
        provider_status="succeeded",
        provider_snapshot={},
        watermark_output_url="https://cdn.test/take-wm.mp4",
    )

    assert [(status, metadata) for *_, status, metadata in live.announced] == [
        ("pending", SHOT),
        ("submitting", SHOT),
        ("submitted", SHOT),
        ("completed", SHOT),
    ], "record_progress 只更新 provider 原始状态，不算一跳"
    assert {(one[0], one[1], one[2], one[3]) for one in live.announced} == {
        (owner, conversation_id, job.id, "video")
    }


async def test_an_image_job_carries_its_metadata_and_a_failure_is_announced_once() -> None:
    live = _RecordingConnections()
    repo = AnnouncingGenerationRepository(InMemoryGenerationRepository(), live)
    job = make_job(image_request(metadata=FRAME), status=STATUS_SUBMITTED, metadata=FRAME)
    await repo.create(job)

    missed = await repo.mark_failed(
        job.id, error_code="LATE", error_message="晚了", only_if_status=STATUS_SUBMITTING
    )
    failed = await repo.mark_failed(
        job.id,
        error_code="PROVIDER_FAILED",
        error_message="上游拒绝",
        only_if_status=STATUS_SUBMITTED,
    )

    assert missed is None
    assert failed is not None and failed.status == "failed"
    assert [(status, metadata) for *_, status, metadata in live.announced] == [
        ("submitted", FRAME),
        ("failed", FRAME),
    ], "状态守卫没命中的那次不发帧"


async def test_a_job_without_a_conversation_still_announces_to_its_owner() -> None:
    live = _RecordingConnections()
    repo = AnnouncingGenerationRepository(InMemoryGenerationRepository(), live)
    job = make_job()

    await repo.create(job)

    assert live.announced == [(job.owner_user_id, None, job.id, "video", "pending", None)]
