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
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
)
from iclip.domains.generation.nano_banana import SPEC as NANO_SPEC
from iclip.domains.generation.provider import ImageModelSpec
from iclip.domains.generation.seedream import SPEC as SEEDREAM_SPEC
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.models import Principal
from iclip.platform.http import status_code_for
from tests.helpers.generation import (
    SHOT_IMAGE_URLS,
    SHOT_PROMPT,
    InMemoryGenerationRepository,
    image_request,
    make_job,
    video_request,
    video_shot,
)
from tests.unit.domains.generation.test_generation_queue import build_queue

VIDEO_MODELS = ("moyu-seedance-2-0", "moyu-seedance-2-5", "wan3.0-video")

VIDEO_BODY = {
    "model": "moyu-seedance-2-5",
    "prompt": "一只猫跳上窗台",
    "aspect_ratio": "16:9",
    "seconds": 5,
}

IMAGE_BODY = {"prompt": "一只猫的正面特写", "aspectRatio": "1:1"}

IMAGE_MODELS = {"nano_banana_pro": NANO_SPEC, "seedream_v5_pro": SEEDREAM_SPEC}


def principal(*permissions: str, user_id: uuid.UUID | None = None) -> Principal:
    return Principal(
        kind="user",
        user_id=user_id or uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="tester",
        username="tester",
    )


def api_key(*permissions: str) -> Principal:
    return Principal(
        kind="api_key",
        user_id=uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="luke#ci",
        api_key_id=uuid.uuid4(),
        username="luke",
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
        video_default_model="moyu-seedance-2-5",
        video_allowed_models=VIDEO_MODELS,
        image_models=image_models if image_models is not None else IMAGE_MODELS,
        image_default_model="nano_banana_pro",
    )
    app.include_router(create_generations_router(service))
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def only_job(repo: InMemoryGenerationRepository) -> GenerationJob:
    (job,) = list(repo.jobs.values())
    return job


# --- 视频提交 ------------------------------------------------------------------


@pytest.mark.parametrize("model", VIDEO_MODELS)
async def test_video_submit_accepts_and_persists_pending_without_calling_provider(
    model: str,
) -> None:
    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations/video", json={**VIDEO_BODY, "model": model})

    assert response.status_code == 202, response.text
    stored = only_job(repo)
    assert response.json() == {"task_id": str(stored.id)}, "回执照上游：只有任务号"
    assert (stored.status, stored.kind, stored.provider) == (STATUS_PENDING, "video", "video_api")
    payload = stored.request.model_dump()
    assert payload["model"] == model
    assert payload["user_name"] == "tester", "浏览器会话没给名字，服务端填登录用户名"


@pytest.mark.parametrize(
    "model", ["mmt-seedance-2-5", "atlas-seedance-2-5", "moyu-seedance-unknown"]
)
async def test_video_submit_rejects_other_models_before_persisting_or_queueing(model: str) -> None:
    repo = InMemoryGenerationRepository()
    # 若错误路径仍尝试入队，坏队列会让此用例失败。
    app = build_test_app(repo, granted=principal("generation:submit"), broken_queue=True)
    async with client(app) as http:
        response = await http.post("/generations/video", json={**VIDEO_BODY, "model": model})

    assert response.status_code == 422
    assert "moyu-seedance-2-5" in response.json()["detail"]
    assert repo.jobs == {}


async def test_video_model_is_required_like_upstream() -> None:
    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    body = {key: value for key, value in VIDEO_BODY.items() if key != "model"}
    async with client(app) as http:
        assert (await http.post("/generations/video", json=body)).status_code == 422


async def test_video_submit_passes_model_specific_fields_through_untouched() -> None:
    """画幅、时长范围、分辨率、私有参数由上游按模型判，受理层不复制那套规则。"""

    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"))
    body = {
        **VIDEO_BODY,
        "aspect_ratio": "7:3",
        "seconds": -1,
        "resolution": "1440p-SR",
        "generate_audio": False,
        "provider_options": {"output_format": "mov"},
        "reference_video_urls": ["https://cdn.test/ref.mp4"],
    }
    async with client(app) as http:
        response = await http.post("/generations/video", json=body)

    assert response.status_code == 202, response.text
    stored = only_job(repo).request.model_dump()
    assert stored["provider_options"] == {"output_format": "mov"}
    assert (stored["seconds"], stored["resolution"], stored["generate_audio"]) == (
        -1,
        "1440p-SR",
        False,
    )


@pytest.mark.parametrize(
    "extra",
    [
        {"image_urls": ["https://cdn.test/a.png"]},
        {"session_id": "s-1"},
        {"kind": "video"},
        {"owner_user_id": str(uuid.uuid4())},
    ],
)
async def test_video_submit_rejects_fields_we_do_not_take(extra: dict[str, object]) -> None:
    """上游会丢弃或兼容的字段，我们直接拒：不静默忽略，也不让身份字段从请求体进来。"""

    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations/video", json={**VIDEO_BODY, **extra})
    assert response.status_code == 422


SHOT_BODY = {
    "model": "moyu-seedance-2-5",
    "aspect_ratio": "16:9",
    "seconds": 6,
    "reference_image_urls": SHOT_IMAGE_URLS,
    "shot": video_shot(),
}


async def test_video_submit_assembles_the_prompt_from_a_shot_and_stores_both() -> None:
    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations/video", json=SHOT_BODY)

    assert response.status_code == 202, response.text
    stored = only_job(repo).request.model_dump()
    assert stored["prompt"] == SHOT_PROMPT
    assert stored["shot"] == {
        "global_settings": "人物保持一致。",
        "timeline": [
            {"seconds": 6.0, "prompt": "走向镜头 @Image1，停下 @Image2。", "image_indexes": [1, 2]}
        ],
    }


@pytest.mark.parametrize(
    "body",
    [
        {key: value for key, value in VIDEO_BODY.items() if key != "prompt"},
        {**SHOT_BODY, "prompt": "自己写的一段正文"},
        {**SHOT_BODY, "reference_image_urls": []},
        {**SHOT_BODY, "shot": video_shot(timeline=[])},
    ],
)
async def test_video_submit_rejects_a_body_whose_text_does_not_hold_together(
    body: dict[str, object],
) -> None:
    """没正文、正文与 shot 打架、引用了不存在的图、空时间线，都在受理前拒掉。"""

    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"), broken_queue=True)
    async with client(app) as http:
        response = await http.post("/generations/video", json=body)

    assert response.status_code == 422, response.text
    assert repo.jobs == {}


async def test_the_old_shared_submit_route_is_gone() -> None:
    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations", json=VIDEO_BODY)
    assert response.status_code == 405, "GET /generations 还在，所以是方法不允许而不是 404"


async def test_historical_video_models_are_read_without_rewriting() -> None:
    job = replace(make_job(video_request(model="mmt-seedance-2-0")), provider="multiflow")
    repo = InMemoryGenerationRepository([job])
    owner = principal("generation:read", user_id=job.owner_user_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        response = await http.get(f"/generations/{job.id}")

    assert response.status_code == 200
    assert response.json()["generation"]["request"]["model"] == "mmt-seedance-2-0"


# --- user_name ---------------------------------------------------------------


async def test_api_key_caller_must_name_its_user_and_is_taken_at_its_word() -> None:
    caller = api_key("generation:submit")
    repo = InMemoryGenerationRepository()
    async with client(build_test_app(repo, granted=caller)) as http:
        nameless = await http.post("/generations/video", json=VIDEO_BODY)
        named = await http.post(
            "/generations/video", json={**VIDEO_BODY, "user_name": "designer-zhang"}
        )

    assert nameless.status_code == 422
    assert "user_name" in nameless.json()["detail"]
    assert named.status_code == 202, named.text
    stored = only_job(repo)
    assert stored.api_key_id == caller.api_key_id
    assert stored.request.model_dump()["user_name"] == "designer-zhang", "不拿 key 属主顶替"


async def test_browser_caller_may_only_name_itself() -> None:
    repo = InMemoryGenerationRepository()
    async with client(build_test_app(repo, granted=principal("generation:submit"))) as http:
        someone_else = await http.post(
            "/generations/video", json={**VIDEO_BODY, "user_name": "bob"}
        )
        itself = await http.post("/generations/video", json={**VIDEO_BODY, "user_name": "tester"})

    assert someone_else.status_code == 422
    assert itself.status_code == 202, itself.text


async def test_image_user_name_follows_the_same_rule() -> None:
    repo = InMemoryGenerationRepository()
    async with client(build_test_app(repo, granted=principal("generation:submit"))) as http:
        filled = await http.post("/generations/image", json=IMAGE_BODY)
        rejected = await http.post("/generations/image", json={**IMAGE_BODY, "userName": "bob"})

    assert filled.status_code == 202, filled.text
    assert filled.json()["generation"]["request"]["userName"] == "tester"
    assert rejected.status_code == 422
    async with client(build_test_app(repo, granted=api_key("generation:submit"))) as http:
        assert (await http.post("/generations/image", json=IMAGE_BODY)).status_code == 422


# --- 图片提交与形状 ----------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"prompt": "猫", "aspectRatio": "1:1", "resolution": "8k"},
        {"prompt": "猫", "aspectRatio": "1:1", "kind": "image"},
        {"prompt": "猫", "aspectRatio": "1:1", "ownerUserId": str(uuid.uuid4())},
        {"prompt": "猫"},
    ],
)
async def test_bad_image_request_shapes_are_rejected(body: dict[str, object]) -> None:
    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations/image", json=body)
    assert response.status_code == 422


async def test_a_frame_number_without_a_shot_is_rejected_at_intake() -> None:
    """帧号只在镜头组内有意义。这条只在受理时查：来源字段落列，读回持久化请求时看不到。"""

    body = {**IMAGE_BODY, "frameNumber": 2}
    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    async with client(app) as http:
        rejected = await http.post("/generations/image", json=body)
        accepted = await http.post("/generations/image", json={**body, "shotIndex": 3})
    assert rejected.status_code == 422
    assert accepted.status_code == 202


@pytest.mark.parametrize(
    ("path", "body"), [("/generations/video", VIDEO_BODY), ("/generations/image", IMAGE_BODY)]
)
async def test_submit_requires_the_submit_permission(path: str, body: dict[str, object]) -> None:
    repo = InMemoryGenerationRepository()
    async with client(build_test_app(repo, granted=principal("generation:read"))) as http:
        assert (await http.post(path, json=body)).status_code == 403
    async with client(build_test_app(repo, granted=None)) as http:
        assert (await http.post(path, json=body)).status_code == 401


# --- 读取与归属 ----------------------------------------------------------------


async def test_reading_someone_elses_generation_is_a_404() -> None:
    """不可见资源返回 404，避免泄漏其存在性。"""

    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    async with client(build_test_app(repo, granted=principal("generation:read"))) as http:
        assert (await http.get(f"/generations/{job.id}")).status_code == 404
        assert (await http.get(f"/generations/video/{job.id}")).status_code == 404


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
        assert (await http.get(f"/generations/video/{job.id}")).status_code == 200


async def test_origin_lands_on_columns_not_in_the_stored_request() -> None:
    """归属字段单独存列，不包含在供应商请求 JSON 中；三个字段两种生成都收。"""

    conversation_id, task_id = uuid.uuid4(), uuid.uuid4()
    repo = InMemoryGenerationRepository()
    caller = principal("generation:submit", "generation:read")
    async with client(build_test_app(repo, granted=caller)) as http:
        submitted = await http.post(
            "/generations/video",
            json={
                **VIDEO_BODY,
                "conversation_id": str(conversation_id),
                "shot_index": 3,
                "task_id": str(task_id),
            },
        )
        assert submitted.status_code == 202, submitted.text
        record = (await http.get(f"/generations/{submitted.json()['task_id']}")).json()[
            "generation"
        ]

    assert (record["shotIndex"], record["taskId"]) == (3, str(task_id))
    assert {"conversation_id", "shot_index", "task_id"}.isdisjoint(record["request"])
    stored = only_job(repo)
    assert (stored.conversation_id, stored.shot_index, stored.task_id) == (
        conversation_id,
        3,
        task_id,
    )


async def test_list_can_be_filtered_by_conversation_and_by_task() -> None:

    owner_id = uuid.uuid4()
    conversation_id, task_id = uuid.uuid4(), uuid.uuid4()
    in_conversation = make_job(
        video_request(), owner_user_id=owner_id, conversation_id=conversation_id
    )
    in_task = make_job(video_request(), owner_user_id=owner_id, task_id=task_id)
    elsewhere = make_job(video_request(), owner_user_id=owner_id)
    theirs = make_job(video_request(), conversation_id=conversation_id, task_id=task_id)
    repo = InMemoryGenerationRepository([in_conversation, in_task, elsewhere, theirs])

    owner = principal("generation:read", user_id=owner_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        by_conversation = await http.get(f"/generations?conversationId={conversation_id}")
        by_task = await http.get(f"/generations?taskId={task_id}")
        everything = await http.get("/generations")

    assert [item["id"] for item in by_conversation.json()["items"]] == [str(in_conversation.id)]
    assert [item["id"] for item in by_task.json()["items"]] == [str(in_task.id)]
    assert len(everything.json()["items"]) == 3, "别人的那条筛不出来，也列不出来"


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
    assert {"taskId", "watermarkOutputUrl"} <= set(body)


async def test_failing_to_enqueue_fails_the_row_instead_of_leaving_it_pending() -> None:
    """任务落库与入队分属两个事务；入队失败须标记失败，避免永久 pending。"""

    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"), broken_queue=True)
    async with client(app) as http:
        with pytest.raises(RuntimeError, match="排队失败"):
            await http.post("/generations/video", json=VIDEO_BODY)

    stored = only_job(repo)
    assert stored.status == "failed"
    assert stored.error_code == "QUEUE_DEFER_FAILED"


# --- 视频任务快照 ------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (STATUS_PENDING, "queued"),
        (STATUS_SUBMITTING, "running"),
        (STATUS_SUBMITTED, "running"),
    ],
)
async def test_video_task_reports_upstream_status_words_while_in_flight(
    status: str, expected: str
) -> None:
    job = make_job(video_request(), status=status)  # type: ignore[arg-type]
    repo = InMemoryGenerationRepository([job])
    owner = principal("generation:read", user_id=job.owner_user_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        body = (await http.get(f"/generations/video/{job.id}")).json()

    assert body["task_id"] == str(job.id)
    assert (body["type"], body["status"]) == ("video", expected)
    assert body["result"] is None and body["error"] is None


async def test_video_task_carries_both_urls_when_done_and_the_error_when_failed() -> None:
    done = make_job(
        video_request(),
        status=STATUS_COMPLETED,
        output_url="https://cdn.test/v.mp4",
        watermark_output_url="https://cdn.test/v-wm.mp4",
    )
    failed = make_job(
        video_request(),
        status=STATUS_FAILED,
        owner_user_id=done.owner_user_id,
        error_code="PROVIDER_ERROR",
        error_message="Reference video duration exceeds the limit.",
    )
    repo = InMemoryGenerationRepository([done, failed])
    owner = principal("generation:read", user_id=done.owner_user_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        succeeded = (await http.get(f"/generations/video/{done.id}")).json()
        errored = (await http.get(f"/generations/video/{failed.id}")).json()

    assert succeeded["status"] == "succeeded"
    assert succeeded["result"] == {
        "output_url": "https://cdn.test/v.mp4",
        "watermark_output_url": "https://cdn.test/v-wm.mp4",
    }
    assert errored["status"] == "failed"
    assert errored["error"] == {
        "code": "PROVIDER_ERROR",
        "message": "Reference video duration exceeds the limit.",
    }


async def test_video_task_endpoint_does_not_answer_for_image_records() -> None:
    job = make_job(image_request())
    repo = InMemoryGenerationRepository([job])
    owner = principal("generation:read", user_id=job.owner_user_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        assert (await http.get(f"/generations/video/{job.id}")).status_code == 404
        assert (await http.get(f"/generations/{job.id}")).status_code == 200


async def test_video_models_endpoint_lists_the_configured_models() -> None:
    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:read"))
    async with client(app) as http:
        response = await http.get("/generations/video-models")

    assert response.status_code == 200
    assert response.json() == {"default": "moyu-seedance-2-5", "items": list(VIDEO_MODELS)}
    async with client(build_test_app(InMemoryGenerationRepository(), granted=principal())) as http:
        assert (await http.get("/generations/video-models")).status_code == 403


# --- 图片模型选择 ------------------------------------------------------------


async def test_image_model_and_channel_are_settled_at_intake() -> None:
    """省略两者时按配置的默认那家与它声明的默认渠道填，并写进 provider 列。"""

    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations/image", json=IMAGE_BODY)

    assert response.status_code == 202
    snapshot = response.json()["generation"]["request"]
    assert snapshot["model"] == "nano_banana_pro"
    assert snapshot["channel"] == "dev", "那家声明的第一个渠道"
    assert only_job(repo).provider == "nano_banana_pro", "API 藏了 provider，只能从库里断"


async def test_image_keeps_the_model_the_caller_named() -> None:
    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post(
            "/generations/image",
            json={**IMAGE_BODY, "model": "seedream_v5_pro", "resolution": "1k"},
        )

    assert response.status_code == 202
    assert response.json()["generation"]["request"]["channel"] is None, "这家没有渠道这个轴"
    assert only_job(repo).provider == "seedream_v5_pro"


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
        response = await http.post("/generations/image", json={**IMAGE_BODY, **body})

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
