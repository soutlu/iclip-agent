"""使用内存仓储验证 /generations 权限、错误映射和受理语义。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import replace

import httpx
import pytest
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from iclip.common.errors import DomainError
from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.models import STATUS_PENDING
from iclip.domains.generation.nano_banana import SPEC as NANO_SPEC
from iclip.domains.generation.provider import ImageModelSpec
from iclip.domains.generation.seedream import SPEC as SEEDREAM_SPEC
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.models import Principal
from iclip.platform.http import status_code_for
from tests.helpers.generation import InMemoryGenerationRepository, make_job, video_request
from tests.unit.domains.generation.test_generation_queue import build_queue

VIDEO_BODY = {
    "kind": "video",
    "prompt": "一只猫跳上窗台",
    "aspectRatio": "16:9",
    "durationSeconds": 5,
}

IMAGE_BODY = {"kind": "image", "prompt": "一只猫的正面特写", "aspectRatio": "1:1"}

IMAGE_MODELS = {"nano_banana_pro": NANO_SPEC, "seedream_v5_pro": SEEDREAM_SPEC}


def principal(*permissions: str, user_id: uuid.UUID | None = None) -> Principal:
    return Principal(
        kind="user",
        user_id=user_id or uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="tester",
    )


def build_test_app(
    repo: InMemoryGenerationRepository,
    *,
    granted: Principal | None,
    broken_queue: bool = False,
    image_models: Mapping[str, ImageModelSpec] | None = None,
) -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def _inject_principal(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if granted is not None:
            request.state.principal = granted
        return await call_next(request)

    @app.exception_handler(DomainError)
    async def _domain_error(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=status_code_for(exc), content={"detail": str(exc)})

    queue, _ = build_queue(repo)
    if broken_queue:

        async def _boom(_job: object) -> None:
            raise RuntimeError("排队失败")

        queue.enqueue_submit = _boom  # type: ignore[method-assign]
    service = GenerationService(
        repo,
        queue,
        video_provider_name="video_api",
        image_models=image_models if image_models is not None else IMAGE_MODELS,
        image_default_model="nano_banana_pro",
        video_model="moyu-seedance-2-5",
        video_allowed_models=("moyu-seedance-2-0", "moyu-seedance-2-5", "wan3.0-video"),
    )
    app.include_router(create_generations_router(service))
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


@pytest.mark.parametrize("model", [None, "moyu-seedance-2-0", "moyu-seedance-2-5", "wan3.0-video"])
async def test_submit_accepts_and_persists_pending_without_calling_provider(
    model: str | None,
) -> None:

    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations", json={**VIDEO_BODY, "model": model})

    assert response.status_code == 202
    body = response.json()["generation"]
    assert body["status"] == STATUS_PENDING
    assert body["outputUrl"] is None
    assert body["request"]["model"] == (model or "moyu-seedance-2-5")
    assert len(repo.jobs) == 1
    assert next(iter(repo.jobs.values())).request.model_dump()["model"] == (
        model or "moyu-seedance-2-5"
    )


@pytest.mark.parametrize(
    "model", ["mmt-seedance-2-5", "atlas-seedance-2-5", "moyu-seedance-unknown"]
)
async def test_submit_rejects_other_video_models_before_persisting_or_queueing(model: str) -> None:
    repo = InMemoryGenerationRepository()
    # 若错误路径仍尝试入队，坏队列会让此用例失败。
    app = build_test_app(repo, granted=principal("generation:submit"), broken_queue=True)
    async with client(app) as http:
        response = await http.post("/generations", json={**VIDEO_BODY, "model": model})

    assert response.status_code == 422
    assert "moyu-seedance-2-5" in response.json()["detail"]
    assert repo.jobs == {}


async def test_historical_video_models_are_read_without_rewriting() -> None:
    job = replace(make_job(video_request(model="mmt-seedance-2-0")), provider="multiflow")
    repo = InMemoryGenerationRepository([job])
    owner = principal("generation:read", user_id=job.owner_user_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        response = await http.get(f"/generations/{job.id}")

    assert response.status_code == 200
    assert response.json()["generation"]["request"]["model"] == "mmt-seedance-2-0"
    assert repo.jobs[job.id].request.model_dump()["model"] == "mmt-seedance-2-0"


async def test_submit_records_the_api_key_that_did_it() -> None:

    key_id = uuid.uuid4()
    caller = Principal(
        kind="api_key",
        user_id=uuid.uuid4(),
        permissions=frozenset({"generation:submit"}),
        audit_label="luke#ci",
        api_key_id=key_id,
    )
    repo = InMemoryGenerationRepository()
    async with client(build_test_app(repo, granted=caller)) as http:
        await http.post("/generations", json=VIDEO_BODY)

    assert next(iter(repo.jobs.values())).api_key_id == key_id


async def test_owner_comes_from_the_principal_not_the_body() -> None:

    caller = principal("generation:submit")
    repo = InMemoryGenerationRepository()
    async with client(build_test_app(repo, granted=caller)) as http:
        response = await http.post(
            "/generations", json={**VIDEO_BODY, "ownerUserId": str(uuid.uuid4())}
        )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "video", "prompt": "猫", "aspectRatio": "7:3", "durationSeconds": 5},
        {"kind": "video", "prompt": "猫", "aspectRatio": "16:9", "durationSeconds": 0},
        {"kind": "image", "prompt": "猫", "aspectRatio": "1:1", "resolution": "8k"},
        {"kind": "audio", "prompt": "猫"},
        {"kind": "video", "prompt": "猫", "aspectRatio": "16:9"},
    ],
)
async def test_bad_request_shapes_are_rejected(body: dict[str, object]) -> None:
    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations", json=body)
    assert response.status_code == 422


async def test_a_frame_number_without_a_shot_is_rejected_at_intake() -> None:
    """帧号只在镜头组内有意义。这条只在受理时查：来源字段落列，读回持久化请求时看不到。"""

    body = {"kind": "image", "prompt": "猫", "aspectRatio": "1:1", "frameNumber": 2}
    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    async with client(app) as http:
        rejected = await http.post("/generations", json=body)
        accepted = await http.post("/generations", json={**body, "shotIndex": 3})
    assert rejected.status_code == 422
    assert accepted.status_code == 202


async def test_submit_requires_the_submit_permission() -> None:
    repo = InMemoryGenerationRepository()
    async with client(build_test_app(repo, granted=principal("generation:read"))) as http:
        assert (await http.post("/generations", json=VIDEO_BODY)).status_code == 403
    async with client(build_test_app(repo, granted=None)) as http:
        assert (await http.post("/generations", json=VIDEO_BODY)).status_code == 401


async def test_reading_someone_elses_generation_is_a_404() -> None:
    """不可见资源返回 404，避免泄漏其存在性。"""

    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    async with client(build_test_app(repo, granted=principal("generation:read"))) as http:
        assert (await http.get(f"/generations/{job.id}")).status_code == 404


async def test_owner_reads_own_generation_and_manager_reads_everyones() -> None:
    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])

    owner = principal("generation:read", user_id=job.owner_user_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        assert (await http.get(f"/generations/{job.id}")).status_code == 200
        assert len((await http.get("/generations")).json()["items"]) == 1

    manager = principal("generation:read", "users:manage")
    async with client(build_test_app(repo, granted=manager)) as http:
        assert (await http.get(f"/generations/{job.id}")).status_code == 200


async def test_origin_lands_on_columns_not_in_the_stored_request() -> None:
    """来源字段属于任务归属，单独存列，不包含在供应商请求 JSON 中。"""

    conversation_id = uuid.uuid4()
    repo = InMemoryGenerationRepository()
    caller = principal("generation:submit")
    async with client(build_test_app(repo, granted=caller)) as http:
        response = await http.post(
            "/generations",
            json={**VIDEO_BODY, "conversationId": str(conversation_id), "shotIndex": 3},
        )

    assert response.status_code == 202, response.text
    body = response.json()["generation"]
    assert body["shotIndex"] == 3
    assert {"conversationId", "shotIndex"}.isdisjoint(body["request"])
    stored = next(iter(repo.jobs.values()))
    assert (stored.conversation_id, stored.shot_index) == (conversation_id, 3)


async def test_list_can_be_filtered_by_conversation() -> None:

    owner_id = uuid.uuid4()
    conversation_id = uuid.uuid4()
    mine = make_job(video_request(), owner_user_id=owner_id, conversation_id=conversation_id)
    elsewhere = make_job(video_request(), owner_user_id=owner_id)
    theirs = make_job(video_request(), conversation_id=conversation_id)
    repo = InMemoryGenerationRepository([mine, elsewhere, theirs])

    owner = principal("generation:read", user_id=owner_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        filtered = await http.get(f"/generations?conversationId={conversation_id}")
        everything = await http.get("/generations")

    assert [item["id"] for item in filtered.json()["items"]] == [str(mine.id)]
    assert len(everything.json()["items"]) == 2


async def test_list_rejects_out_of_range_limit() -> None:
    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:read"))
    async with client(app) as http:
        assert (await http.get("/generations?limit=0")).status_code == 422
        assert (await http.get("/generations?limit=1000")).status_code == 422


async def test_response_hides_provider_snapshot_and_queue_mechanics() -> None:
    """响应排除包含签名 URL 的供应商快照及内部队列字段。"""

    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    owner = principal("generation:read", user_id=job.owner_user_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        body = (await http.get(f"/generations/{job.id}")).json()["generation"]

    hidden = {"providerSnapshot", "providerTaskId", "provider", "leaseOwner", "attempts"}
    assert hidden.isdisjoint(body)


async def test_failing_to_enqueue_fails_the_row_instead_of_leaving_it_pending() -> None:
    """任务落库与入队分属两个事务；入队失败须标记失败，避免永久 pending。"""

    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"), broken_queue=True)
    async with client(app) as http:
        with pytest.raises(RuntimeError, match="排队失败"):
            await http.post("/generations", json=VIDEO_BODY)

    (stored,) = list(repo.jobs.values())
    assert stored.status == "failed"
    assert stored.error_code == "QUEUE_DEFER_FAILED"


async def test_image_model_and_channel_are_settled_at_intake() -> None:
    """省略两者时按配置的默认那家与它声明的默认渠道填，并写进 provider 列。"""

    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations", json=IMAGE_BODY)

    assert response.status_code == 202
    snapshot = response.json()["generation"]["request"]
    assert snapshot["model"] == "nano_banana_pro"
    assert snapshot["channel"] == "dev", "那家声明的第一个渠道"
    stored = next(iter(repo.jobs.values()))
    assert stored.provider == "nano_banana_pro", "API 藏了 provider，只能从库里断"


async def test_image_keeps_the_model_the_caller_named() -> None:
    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post(
            "/generations", json={**IMAGE_BODY, "model": "seedream_v5_pro", "resolution": "1k"}
        )

    assert response.status_code == 202
    assert response.json()["generation"]["request"]["channel"] is None, "这家没有渠道这个轴"
    assert next(iter(repo.jobs.values())).provider == "seedream_v5_pro"


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"model": "没装配过的一家"}, "图片生成仅支持模型"),
        ({"model": "seedream_v5_pro", "aspectRatio": "4:5"}, "不支持画幅 4:5"),
        ({"model": "seedream_v5_pro", "resolution": "4k"}, "不支持分辨率 4k"),
        ({"model": "seedream_v5_pro", "channel": "dev"}, "没有渠道这个轴"),
    ],
)
async def test_image_requests_beyond_the_model_are_rejected_before_queueing(
    body: dict[str, str], expected: str
) -> None:
    """按所选模型的能力声明拦在受理层，不留下一行已排队、可能已付费的失败。"""

    repo = InMemoryGenerationRepository()
    # 若错误路径仍尝试入队，坏队列会让此用例失败。
    app = build_test_app(repo, granted=principal("generation:submit"), broken_queue=True)
    async with client(app) as http:
        response = await http.post("/generations", json={**IMAGE_BODY, **body})

    assert response.status_code == 422
    assert expected in response.json()["detail"]
    assert repo.jobs == {}


async def test_image_models_endpoint_declares_what_intake_enforces() -> None:
    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:read"))
    async with client(app) as http:
        response = await http.get("/generations/image-models")

    assert response.status_code == 200
    body = response.json()
    assert body["default"] == "nano_banana_pro"
    assert [item["model"] for item in body["items"]] == ["nano_banana_pro", "seedream_v5_pro"]
    narrow = body["items"][1]
    assert narrow["label"] == "Seedream 5.0 Pro"
    assert "4:5" not in narrow["aspectRatios"], "这家没有这一档"
    assert narrow["resolutions"] == ["1k", "2k"], "这家没有 4k"
    assert narrow["channels"] == [], "空数组即这家没有渠道这个轴"


async def test_image_models_endpoint_needs_read_permission() -> None:
    app = build_test_app(InMemoryGenerationRepository(), granted=principal())
    async with client(app) as http:
        assert (await http.get("/generations/image-models")).status_code == 403
