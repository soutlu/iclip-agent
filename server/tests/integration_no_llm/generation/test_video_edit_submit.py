"""编辑段从受理到交上游走一遍装配好的模块：切参考片段、记实际切点、片段地址只进上游请求。

切片用真 ffmpeg 读本地 HTTP 服务上的基底；上游是计数的 MockTransport，断言付费接口调没调。"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest
from procrastinate.testing import InMemoryConnector

from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTED,
    GenerationJob,
    GenerationStatus,
)
from iclip.domains.generation.module import ImageModelConfig, build_generation_module
from iclip.domains.generation.schemas import VideoEditIn
from iclip.domains.generation.video import VideoProviderSettings
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from iclip.platform.media.ffmpeg import ffmpeg_available
from tests.helpers.generation import (
    FixedLineage,
    InMemoryGenerationRepository,
    MemoryObjectStore,
    make_job,
    stored_request,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository
from tests.helpers.media import synthesize_video
from tests.helpers.media_server import serving

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

MODEL = "moyu-seedance-2-5"

PRINCIPAL = Principal(
    kind="user",
    user_id=uuid.uuid4(),
    permissions=frozenset({"generation:submit"}),
    audit_label="tester",
    username="tester",
)


async def _keep_completion(_conversation_id: uuid.UUID, _owner: uuid.UUID) -> None:
    return None


class _SettledDuringCut(InMemoryGenerationRepository):
    """切片期间别的执行先给这一行下了结论（heal 判 worker 失联后重排的那一次）。"""

    async def record_reference_cut(
        self,
        job_id: uuid.UUID,
        *,
        range_start_ms: int,
        range_end_ms: int,
        only_if_status: GenerationStatus,
    ) -> GenerationJob | None:
        await self.mark_failed(
            job_id, error_code="SUBMIT_INTERRUPTED", error_message="别的执行先下了结论"
        )
        return await super().record_reference_cut(
            job_id,
            range_start_ms=range_start_ms,
            range_end_ms=range_end_ms,
            only_if_status=only_if_status,
        )


async def _run_edit(
    repo: InMemoryGenerationRepository, *, start_ms: int, end_ms: int
) -> tuple[GenerationJob, list[dict[str, Any]], MemoryObjectStore]:
    """在一条已完成的出片上受理一次编辑段并跑提交；返回落库的编辑段、上游收到的请求与桶。"""

    sent: list[dict[str, Any]] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"task_id": "upstream-1"})

    store = MemoryObjectStore()
    module = build_generation_module(
        repo,
        act_as=ActAs(InMemoryUserRepository()),
        clear_completion=_keep_completion,
        lineage=FixedLineage(),
        video=VideoProviderSettings(
            submit_url="https://video.test/generate",
            status_base_url="https://video.test/tasks",
            api_key="secret-key",
        ),
        video_default_model=MODEL,
        video_allowed_models=(MODEL,),
        image_models=[
            ImageModelConfig(name="nano_banana_pro", api_base="https://image.test", concurrency=1)
        ],
        image_default_model="nano_banana_pro",
        image_env="test",
        object_store=store,
        queue_connector=InMemoryConnector(),
        video_transport=httpx.MockTransport(upstream),
    )
    with TemporaryDirectory(prefix="edit-fixture-") as tmp:
        base = synthesize_video(Path(tmp) / "base.mp4", size="320x240", seconds=4, audio=True)
    async with serving({"base.mp4": base}) as server:
        take = make_job(
            video_request(),
            status=STATUS_COMPLETED,
            owner_user_id=PRINCIPAL.user_id,
            output_url=server.url("base.mp4"),
        )
        repo.jobs[take.id] = take
        job = await module.service.submit_video_edit(
            PRINCIPAL,
            VideoEditIn(
                source_job_id=take.id,
                range_start_ms=start_ms,
                range_end_ms=end_ms,
                model=MODEL,
                prompt="换一双鞋",
                user_name="tester",
                seconds=-1,
            ),
        )
        await module.queue.run_submit(str(job.id))
    return repo.jobs[job.id], sent, store


async def test_an_edit_is_cut_recorded_and_sent_upstream_with_the_clip() -> None:
    edit, sent, store = await _run_edit(InMemoryGenerationRepository(), start_ms=1500, end_ms=3000)

    assert edit.status == STATUS_SUBMITTED, edit.error_message
    (body,) = sent
    assert body["reference_video_urls"] == [
        store.public_url(f"iclip/agent/video-clips/{edit.id}.mp4")
    ]
    assert (body["seconds"], body["user_name"], body["prompt"]) == (-1, "tester", "换一双鞋")
    assert edit.range_end_ms == 3000
    assert edit.range_start_ms is not None and edit.range_start_ms < 1500, "改记关键帧上的实际起点"
    assert stored_request(edit).model_dump()["reference_video_urls"] == [], (
        "片段地址不回写落库的请求"
    )
    assert edit.provider_status == "queued", "切片的阶段词已清掉，换成上游回执"


async def test_a_start_outside_the_base_fails_the_edit_before_upstream() -> None:
    edit, sent, _ = await _run_edit(InMemoryGenerationRepository(), start_ms=5000, end_ms=6000)

    assert (edit.status, edit.error_code) == (STATUS_FAILED, "EDIT_RANGE_OUT_OF_BOUNDS")
    assert sent == [], "付费上游一次都不调"


async def test_an_edit_settled_during_the_cut_never_reaches_upstream() -> None:
    """切好时这一行已有结论：切点不记、上游不调，先下的那个结论不被覆盖。"""

    edit, sent, _ = await _run_edit(_SettledDuringCut(), start_ms=1000, end_ms=3000)

    assert sent == []
    assert (edit.status, edit.error_code) == (STATUS_FAILED, "SUBMIT_INTERRUPTED")
    assert (edit.range_start_ms, edit.range_end_ms) == (1000, 3000), "切点没记上"
