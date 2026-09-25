"""使用内存仓储验证 /generations 权限、错误映射和受理语义。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationStatus,
)
from iclip.domains.generation.nano_banana import NANO_BANANA_PRO
from iclip.domains.generation.provider import ImageModelSpec
from iclip.domains.generation.schemas import MAX_METADATA_CHARS, VideoComposeRequest
from iclip.domains.generation.seedream import SEEDREAM_V5_PRO
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION
from tests.helpers.app import app_with_principal
from tests.helpers.generation import (
    SHOT_IMAGE_URLS,
    SHOT_PROMPT,
    FixedLineage,
    InMemoryGenerationRepository,
    build_queue,
    image_request,
    make_composite,
    make_edit,
    make_job,
    video_request,
    video_shot,
)
from tests.helpers.identity import InMemoryUserRepository

VIDEO_MODELS = ("moyu-seedance-2-0", "moyu-seedance-2-5", "wan3.0-video")

VIDEO_BODY = {
    "model": "moyu-seedance-2-5",
    "prompt": "一只猫跳上窗台",
    "aspect_ratio": "16:9",
    "seconds": 5,
}

IMAGE_BODY = {"prompt": "一只猫的正面特写", "aspectRatio": "1:1"}

EDIT_BODY = {
    "model": "moyu-seedance-2-5",
    "prompt": "把凉鞋换成编织款",
    "range_start_ms": 1000,
    "range_end_ms": 4000,
    "seconds": -1,
    "reference_image_urls": ["https://cdn.test/sandal.png"],
}
"""编辑段请求体，缺 ``source_job_id`` 与归属，用例按需补。"""

IMAGE_MODELS = {"nano_banana_pro": NANO_BANANA_PRO.spec, "seedream_v5_pro": SEEDREAM_V5_PRO.spec}


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
        key_name="ci",
    )


class ClearedCompletions:
    """替身：记下受理出片后回调取消了哪些对话的收尾标记。"""

    def __init__(self) -> None:
        self.calls: list[tuple[uuid.UUID, uuid.UUID]] = []

    async def record(self, conversation_id: uuid.UUID, owner: uuid.UUID) -> None:
        self.calls.append((conversation_id, owner))


def build_test_app(
    repo: InMemoryGenerationRepository,
    *,
    granted: Principal | None,
    broken_queue: bool = False,
    image_models: Mapping[str, ImageModelSpec] | None = None,
    lineage: FixedLineage | None = None,
) -> FastAPI:
    app = app_with_principal(granted)
    cleared = ClearedCompletions()
    app.state.cleared_completions = cleared

    queue, _ = build_queue(repo)
    if broken_queue:

        async def _boom(_job: object) -> None:
            raise RuntimeError("排队失败")

        queue.enqueue_submit = _boom  # type: ignore[method-assign]
    service = GenerationService(
        repo,
        queue,
        video_provider_name="video_api",
        clip_provider_name="ffmpeg",
        video_default_model="moyu-seedance-2-5",
        video_allowed_models=VIDEO_MODELS,
        image_models=image_models if image_models is not None else IMAGE_MODELS,
        image_default_model="nano_banana_pro",
        clear_completion=cleared.record,
        lineage=lineage or FixedLineage(),
    )
    app.include_router(create_generations_router(service, act_as=ActAs(InMemoryUserRepository())))
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def only_job(repo: InMemoryGenerationRepository) -> GenerationJob:
    (job,) = list(repo.jobs.values())
    return job


def test_openapi_publishes_generation_kind_operation_and_status_as_enums() -> None:
    """前端从合同派生类型与状态词，合同里只剩字符串就只能手写平行词表。"""

    app = build_test_app(InMemoryGenerationRepository(), granted=None)
    fields = app.openapi()["components"]["schemas"]["GenerationOut"]["properties"]
    assert fields["kind"]["enum"] == ["video", "image"]
    assert fields["operation"]["enum"] == ["generate", "compose"]
    assert fields["status"]["enum"] == ["pending", "submitting", "submitted", "completed", "failed"]


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
        {"root_job_id": str(uuid.uuid4())},
    ],
)
async def test_video_submit_rejects_fields_we_do_not_take(extra: dict[str, object]) -> None:
    """上游会丢弃或兼容的字段，我们直接拒：不静默忽略，也不让身份字段与服务端定的原作从请求体进来。"""

    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations/video", json={**VIDEO_BODY, **extra})
    assert response.status_code == 422


async def test_reference_urls_stop_at_the_same_count_the_shot_file_allows() -> None:
    """分镜文件一组能挂 30 张帧图，出片就得收得下 30 张：存得下却发不出去是我们自己的口径打架。"""

    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    urls = [f"https://cdn.test/{index}.png" for index in range(31)]
    async with client(app) as http:
        fits = await http.post(
            "/generations/video", json={**VIDEO_BODY, "reference_image_urls": urls[:30]}
        )
        too_many = await http.post(
            "/generations/video", json={**VIDEO_BODY, "reference_image_urls": urls}
        )

    assert fits.status_code == 202, fits.text
    assert too_many.status_code == 422
    assert too_many.json()["detail"].startswith("reference_image_urls: ")


async def test_request_validation_errors_use_the_same_string_envelope() -> None:
    """校验失败也走 ``{"detail": "<字段路径>: <原因>"}``，调用方读同一个字段就够。"""

    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post(
            "/generations/video", json={**VIDEO_BODY, "reference_image_urls": ["ftp://cdn/a.png"]}
        )

    assert response.status_code == 422
    assert response.json() == {
        "detail": "reference_image_urls: [0] 必须是 http:// 或 https:// 地址"
    }


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
            {
                "timestamps": (0, 6),
                "prompt": "走向镜头 @Image1，停下 @Image2。",
                "image_indexes": [1, 2],
            }
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


@pytest.mark.parametrize("path", ["/generations", "/generations/clips"])
async def test_retired_submit_routes_are_gone(path: str) -> None:
    """共用提交口与本地裁剪拼接口都已下线：编辑与合成各走自己的入口。"""

    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post(path, json=VIDEO_BODY)
    assert response.status_code == 405, "同路径的 GET 还在，所以是方法不允许而不是 404"


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


async def test_oversized_metadata_is_rejected_at_intake() -> None:
    """坐标是标签不是仓库：序列化超过上限就拒，两种生成同一条线。"""

    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:submit"))
    async with client(app) as http:
        image = await http.post(
            "/generations/image", json={**IMAGE_BODY, "metadata": {"note": "x" * 2001}}
        )
        video = await http.post(
            "/generations/video", json={**VIDEO_BODY, "metadata": {"note": "x" * 2001}}
        )
        fits = await http.post(
            "/generations/image", json={**IMAGE_BODY, "metadata": {"path": "a.json", "shot": 1}}
        )
    assert (image.status_code, video.status_code, fits.status_code) == (422, 422, 202)


async def test_metadata_filter_is_containment_and_bad_filters_are_422() -> None:
    """``metadata`` 是调用方的坐标：按包含匹配筛，服务端不读键；查询串里不是 JSON 对象就是 422。"""

    owner = uuid.uuid4()
    coordinate = {"path": "video_shot.json", "shot": 1, "frame": 2}
    hit = make_job(image_request(metadata=coordinate), owner_user_id=owner, metadata=coordinate)
    sibling = {**coordinate, "frame": 3}
    other = make_job(image_request(metadata=sibling), owner_user_id=owner, metadata=sibling)
    untagged = make_job(owner_user_id=owner)
    repo = InMemoryGenerationRepository([hit, other, untagged])
    app = build_test_app(repo, granted=principal("generation:read", user_id=owner))
    async with client(app) as http:
        by_frame = await http.get(
            "/generations", params={"metadata": json.dumps({"shot": 1, "frame": 2})}
        )
        by_shot = await http.get("/generations", params={"metadata": json.dumps({"shot": 1})})
        not_json = await http.get("/generations", params={"metadata": "not json"})
        not_object = await http.get("/generations", params={"metadata": "[1]"})
        oversized = await http.get(
            "/generations", params={"metadata": json.dumps({"note": "x" * 2001})}
        )
    assert [item["id"] for item in by_frame.json()["items"]] == [str(hit.id)]
    assert {item["id"] for item in by_shot.json()["items"]} == {str(hit.id), str(other.id)}
    assert (not_json.status_code, not_object.status_code) == (422, 422)
    assert oversized.status_code == 422
    detail = oversized.json()["detail"]
    assert str(MAX_METADATA_CHARS) in detail
    assert not detail.startswith("Value error"), "与请求体的 422 同一口径：不带 pydantic 的前缀"


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/generations/video", VIDEO_BODY),
        ("/generations/image", IMAGE_BODY),
        ("/generations/video-edits", {**EDIT_BODY, "source_job_id": str(uuid.uuid4())}),
        ("/generations/video-composites", {"sourceJobId": str(uuid.uuid4())}),
    ],
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
    """归属字段单独存列，不包含在供应商请求 JSON 中；三个字段两种生成都收，坐标原样回读。"""

    conversation_id, task_id = uuid.uuid4(), uuid.uuid4()
    repo = InMemoryGenerationRepository()
    caller = principal("generation:submit", "generation:read")
    async with client(build_test_app(repo, granted=caller)) as http:
        submitted = await http.post(
            "/generations/video",
            json={
                **VIDEO_BODY,
                "conversation_id": str(conversation_id),
                "metadata": {"path": "video_shot.json", "shot": 3},
                "task_id": str(task_id),
            },
        )
        assert submitted.status_code == 202, submitted.text
        record = (await http.get(f"/generations/{submitted.json()['task_id']}")).json()[
            "generation"
        ]

    assert (record["metadata"], record["taskId"]) == (
        {"path": "video_shot.json", "shot": 3},
        str(task_id),
    )
    assert {"conversation_id", "metadata", "task_id"}.isdisjoint(record["request"])
    stored = only_job(repo)
    assert (stored.conversation_id, stored.metadata, stored.task_id) == (
        conversation_id,
        {"path": "video_shot.json", "shot": 3},
        task_id,
    )


async def test_the_shot_number_is_shot_index_alone_and_metadata_stays_the_callers() -> None:
    """镜号只认 ``shot_index``：落记录的列、回显在 ``shotIndex``；metadata 原样存取，里面的 shot 不当镜号。"""

    repo = InMemoryGenerationRepository()
    caller = principal("generation:submit", "generation:read")
    async with client(build_test_app(repo, granted=caller)) as http:
        numbered = await http.post(
            "/generations/video", json={**VIDEO_BODY, "shot_index": 3, "metadata": {"frame": 1}}
        )
        tagged = await http.post("/generations/video", json={**VIDEO_BODY, "metadata": {"shot": 9}})
        records = [
            (await http.get(f"/generations/{response.json()['task_id']}")).json()["generation"]
            for response in (numbered, tagged)
        ]

    assert [(record["shotIndex"], record["metadata"]) for record in records] == [
        (3, {"frame": 1}),
        (None, {"shot": 9}),
    ]
    assert "shot_index" not in records[0]["request"], "镜号不进发给上游的请求"
    assert {job.shot_index for job in repo.jobs.values()} == {3, None}


async def test_list_filters_by_shot_index_and_stacks_with_metadata() -> None:
    """按镜号筛与按坐标筛叠加收窄；坐标里写的 shot 不算镜号；镜号从 1 起。"""

    owner_id = uuid.uuid4()

    def take(shot_index: int | None, metadata: dict[str, object] | None) -> GenerationJob:
        return make_job(
            video_request(), owner_user_id=owner_id, shot_index=shot_index, metadata=metadata
        )

    first_frame, second_frame = take(3, {"frame": 1}), take(3, {"frame": 2})
    repo = InMemoryGenerationRepository(
        [first_frame, second_frame, take(4, {"frame": 1}), take(None, {"shot": 3})]
    )
    app = build_test_app(repo, granted=principal("generation:read", user_id=owner_id))
    async with client(app) as http:
        by_shot = await http.get("/generations", params={"shotIndex": 3})
        stacked = await http.get(
            "/generations", params={"shotIndex": 3, "metadata": json.dumps({"frame": 1})}
        )
        zero = await http.get("/generations", params={"shotIndex": 0})

    assert {item["id"] for item in by_shot.json()["items"]} == {
        str(first_frame.id),
        str(second_frame.id),
    }
    assert [item["id"] for item in stacked.json()["items"]] == [str(first_frame.id)]
    assert zero.status_code == 422


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


async def test_list_can_be_filtered_by_root_source_and_operation() -> None:
    """以一条出片为原作的就是它的编辑链；按直接来源找基于某一行的；按操作把合成单拎出来。"""

    owner_id = uuid.uuid4()
    root = make_job(video_request(), owner_user_id=owner_id, status=STATUS_COMPLETED)
    other_root = make_job(video_request(), owner_user_id=owner_id, status=STATUS_COMPLETED)
    edit = make_edit(root, owner_user_id=owner_id, status=STATUS_COMPLETED)
    composite = make_composite(edit, owner_user_id=owner_id)
    elsewhere = make_edit(other_root, owner_user_id=owner_id)
    repo = InMemoryGenerationRepository([root, other_root, edit, composite, elsewhere])

    owner = principal("generation:read", user_id=owner_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        by_root = await http.get("/generations", params={"rootJobId": str(root.id)})
        by_source = await http.get("/generations", params={"sourceJobId": str(edit.id)})
        composites = await http.get("/generations", params={"operation": "compose"})
        bad = await http.get("/generations", params={"operation": "cut"})

    assert {item["id"] for item in by_root.json()["items"]} == {str(edit.id), str(composite.id)}
    (item,) = by_source.json()["items"]
    assert (item["id"], item["sourceJobId"], item["rootJobId"]) == (
        str(composite.id),
        str(edit.id),
        str(root.id),
    )
    assert [item["id"] for item in composites.json()["items"]] == [str(composite.id)]
    assert bad.status_code == 422


def fork_of_someone_elses_take(
    forker: uuid.UUID, *, readable: bool
) -> tuple[InMemoryGenerationRepository, uuid.UUID, GenerationJob, GenerationJob, FixedLineage]:
    """别人在源对话里出成的一条，和分叉的人在副本里自己的一条；主体读不读得到副本由调用方定。"""

    source, fork = uuid.uuid4(), uuid.uuid4()
    forked_at = datetime.now(UTC)
    inherited = make_job(
        video_request(),
        status=STATUS_COMPLETED,
        conversation_id=source,
        created_at=forked_at - timedelta(minutes=2),
        finished_at=forked_at - timedelta(minutes=1),
        output_url="https://example.com/source.mp4",
    )
    own = make_job(video_request(), owner_user_id=forker, conversation_id=fork)
    return (
        InMemoryGenerationRepository([inherited, own]),
        fork,
        inherited,
        own,
        FixedLineage({fork: ((source, forked_at),)}, readable=readable),
    )


@pytest.mark.parametrize("readable", [True, False], ids=["读得到副本", "读不到副本"])
async def test_listing_a_fork_adds_what_it_inherited_only_for_those_who_can_read_it(
    readable: bool,
) -> None:
    """按对话列副本：读得到副本就连同继承的一起给；读不到只按属主口径，不另报 404。"""

    forker = uuid.uuid4()
    repo, fork, inherited, own, lineage = fork_of_someone_elses_take(forker, readable=readable)
    app = build_test_app(
        repo, granted=principal("generation:read", user_id=forker), lineage=lineage
    )
    async with client(app) as http:
        response = await http.get(f"/generations?conversationId={fork}")

    assert response.status_code == 200, response.text
    listed = {item["id"] for item in response.json()["items"]}
    assert listed == ({str(own.id), str(inherited.id)} if readable else {str(own.id)})


@pytest.mark.parametrize("readable", [True, False], ids=["读得到副本", "读不到副本"])
async def test_an_inherited_base_counts_only_for_those_who_can_read_the_fork(
    readable: bool,
) -> None:
    """在副本里剪源对话里别人的出片：读得到副本才算继承；读不到就剪不了，也探不出它在不在。"""

    forker = uuid.uuid4()
    repo, fork, inherited, _, lineage = fork_of_someone_elses_take(forker, readable=readable)
    app = build_test_app(
        repo, granted=principal("generation:submit", user_id=forker), lineage=lineage
    )
    async with client(app) as http:
        response = await http.post(
            "/generations/video-edits",
            json={**EDIT_BODY, "conversation_id": str(fork), "source_job_id": str(inherited.id)},
        )

    assert response.status_code == (202 if readable else 422), response.text
    if readable:
        edit = repo.jobs[uuid.UUID(response.json()["generation"]["id"])]
        assert (edit.conversation_id, edit.owner_user_id, edit.root_job_id) == (
            fork,
            forker,
            inherited.id,
        ), "剪出来的记在副本名下，原作指源对话那条"


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
    assert body["durationMs"] is None, "只有本系统自己加工的视频知道产物多长"


async def read_back(job: GenerationJob) -> dict[str, object]:
    """属主读回这一条的对外形状。"""

    repo = InMemoryGenerationRepository([job])
    owner = principal("generation:read", user_id=job.owner_user_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        return (await http.get(f"/generations/{job.id}")).json()["generation"]


def a_composite(**fields: object) -> GenerationJob:
    """一条合成：挂在一次编辑段上，编辑段又挂在一次出片上。"""

    return make_composite(make_edit(make_job(video_request())), **fields)


async def test_the_duration_comes_from_its_column_not_from_any_snapshot() -> None:
    """合成是本系统自己拼的，量过的时长记在列上交出来；快照里有同名键也不认。"""

    composite = a_composite(status=STATUS_COMPLETED, duration_ms=7040, provider_snapshot={})
    take = make_job(video_request(), provider_snapshot={"durationMs": 5000})
    unmeasured = a_composite(status=STATUS_COMPLETED, provider_snapshot={"durationMs": 7040})

    body = await read_back(composite)
    assert body["durationMs"] == 7040
    assert "providerSnapshot" not in body, "快照本身仍不外露"
    assert (await read_back(take))["durationMs"] is None
    assert (await read_back(unmeasured))["durationMs"] is None


async def test_a_record_reads_back_with_its_operation_source_range_and_finish() -> None:
    finished_at = datetime.now(UTC)
    take = make_job(video_request(), status=STATUS_COMPLETED)
    edit = make_edit(
        take,
        status=STATUS_COMPLETED,
        range_start_ms=800,
        range_end_ms=4000,
        finished_at=finished_at,
    )

    body = await read_back(edit)

    assert (body["kind"], body["operation"], body["sourceJobId"], body["rootJobId"]) == (
        "video",
        "generate",
        str(take.id),
        str(take.id),
    )
    assert (body["rangeStartMs"], body["rangeEndMs"]) == (800, 4000)
    assert datetime.fromisoformat(str(body["finishedAt"])) == finished_at
    plain = await read_back(make_job(video_request()))
    assert (plain["sourceJobId"], plain["rangeStartMs"], plain["finishedAt"]) == (None, None, None)


@pytest.mark.parametrize("role", ["合成", "编辑段"])
async def test_in_flight_local_processing_reports_the_stage_it_is_on(role: str) -> None:
    """合成在拼、编辑段在交上游前切片时，阶段词都照实给。"""

    job = (
        a_composite(status=STATUS_SUBMITTING)
        if role == "合成"
        else make_edit(make_job(video_request()), status=STATUS_SUBMITTING)
    )

    body = await read_back(replace(job, provider_status="uploading"))

    assert body["clipStage"] == "uploading"


@pytest.mark.parametrize(
    ("status", "provider_status", "why"),
    [
        (STATUS_PENDING, None, "还在排队，阶段由 status 表达"),
        (STATUS_FAILED, "uploading", "收尾不写 provider_status，列里会留着最后上报的那个词"),
        (STATUS_SUBMITTING, "whatever", "没见过的词不外露"),
        (STATUS_SUBMITTED, "queued", "交给上游之后是上游的状态词"),
    ],
)
async def test_clip_stage_is_empty_unless_it_is_a_known_in_flight_stage(
    status: GenerationStatus, provider_status: str | None, why: str
) -> None:
    body = await read_back(replace(a_composite(status=status), provider_status=provider_status))

    assert body["clipStage"] is None, why


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


@pytest.mark.parametrize("role", ["图片", "合成"])
async def test_video_task_endpoint_answers_only_for_upstream_video_records(role: str) -> None:
    """上游任务查询的形状只套得上出片与编辑段；图片、合成（没有水印版）与不存在同样是 404。"""

    job = (
        make_job(image_request())
        if role == "图片"
        else a_composite(status=STATUS_COMPLETED, output_url="https://cdn.test/master.mp4")
    )
    edit = make_edit(make_job(video_request()), owner_user_id=job.owner_user_id)
    repo = InMemoryGenerationRepository([job, edit])
    owner = principal("generation:read", user_id=job.owner_user_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        assert (await http.get(f"/generations/video/{job.id}")).status_code == 404
        assert (await http.get(f"/generations/{job.id}")).status_code == 200
        assert (await http.get(f"/generations/video/{edit.id}")).status_code == 200


async def test_video_models_endpoint_lists_the_configured_models() -> None:
    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:read"))
    async with client(app) as http:
        response = await http.get("/generations/video-models")

    assert response.status_code == 200
    assert response.json() == {"default": "moyu-seedance-2-5", "items": list(VIDEO_MODELS)}, (
        "只有模型 id；哪个能编辑、怎么触发由前端按名字认"
    )
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


# --- 视频编辑：编辑段与合成 ---------------------------------------------------

BASE_URL = "https://example.com/base.mp4"
EDITED_URL = "https://example.com/edited.mp4"


def seed_take(
    repo: InMemoryGenerationRepository,
    *,
    owner: uuid.UUID,
    conversation: uuid.UUID | None = None,
    shot_index: int | None = None,
) -> GenerationJob:
    """先放一条已完成的出片进去当基底。"""

    take = make_job(
        video_request(),
        status=STATUS_COMPLETED,
        owner_user_id=owner,
        conversation_id=conversation,
        shot_index=shot_index,
        output_url=BASE_URL,
        watermark_output_url="https://example.com/base-wm.mp4",
        finished_at=datetime.now(UTC) - timedelta(minutes=10),
    )
    repo.jobs[take.id] = take
    return take


def seed_edit(
    repo: InMemoryGenerationRepository,
    base: GenerationJob,
    *,
    status: GenerationStatus = STATUS_COMPLETED,
    range_start_ms: int = 1000,
) -> GenerationJob:
    """在 ``base`` 上放一条编辑段，与基底同属主、同对话。"""

    edit = make_edit(
        base,
        status=status,
        owner_user_id=base.owner_user_id,
        conversation_id=base.conversation_id,
        range_start_ms=range_start_ms,
        range_end_ms=4000,
        output_url=EDITED_URL if status == STATUS_COMPLETED else None,
        finished_at=datetime.now(UTC) - timedelta(minutes=5)
        if status == STATUS_COMPLETED
        else None,
    )
    repo.jobs[edit.id] = edit
    return edit


def only_new(repo: InMemoryGenerationRepository, seeded: set[uuid.UUID]) -> GenerationJob:
    """仓储里种子之外刚受理的那一条。"""

    (job,) = [job for job in repo.jobs.values() if job.id not in seeded]
    return job


async def test_an_edit_on_a_take_is_accepted_as_a_video_generate_with_source_and_range() -> None:
    """编辑段走视频上游：来源与原作都是那条出片，区间先按请求记；落库的请求没有参考视频。"""

    repo = InMemoryGenerationRepository()
    owner, conversation, task = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    take = seed_take(repo, owner=owner, conversation=conversation)
    app = build_test_app(repo, granted=principal("generation:submit", user_id=owner))
    async with client(app) as http:
        response = await http.post(
            "/generations/video-edits",
            json={
                **EDIT_BODY,
                "source_job_id": str(take.id),
                "conversation_id": str(conversation),
                "task_id": str(task),
                "metadata": {"frame": 1},
            },
        )

    assert response.status_code == 202, response.text
    stored = only_new(repo, {take.id})
    assert (stored.kind, stored.operation, stored.provider, stored.status) == (
        "video",
        "generate",
        "video_api",
        STATUS_PENDING,
    )
    assert (stored.source_job_id, stored.root_job_id) == (take.id, take.id)
    assert (stored.range_start_ms, stored.range_end_ms) == (1000, 4000)
    assert (stored.conversation_id, stored.task_id, stored.metadata) == (
        conversation,
        task,
        {"frame": 1},
    )
    request = stored.request.model_dump()
    assert request["reference_video_urls"] == [], "片段由服务端提交上游前再切"
    assert (request["user_name"], request["seconds"], request["reference_image_urls"]) == (
        "tester",
        -1,
        ["https://cdn.test/sandal.png"],
    )
    generation = response.json()["generation"]
    assert (generation["id"], generation["sourceJobId"], generation["rangeStartMs"]) == (
        str(stored.id),
        str(take.id),
        1000,
    )
    assert app.state.cleared_completions.calls == [(conversation, owner)], "又开工了，收尾标记抹掉"


async def test_an_edit_on_a_composite_keeps_the_original_take_as_its_root() -> None:
    repo = InMemoryGenerationRepository()
    owner = uuid.uuid4()
    take = seed_take(repo, owner=owner)
    composite = make_composite(
        seed_edit(repo, take), status=STATUS_COMPLETED, owner_user_id=owner, output_url=BASE_URL
    )
    repo.jobs[composite.id] = composite
    seeded = set(repo.jobs)
    app = build_test_app(repo, granted=principal("generation:submit", user_id=owner))
    async with client(app) as http:
        response = await http.post(
            "/generations/video-edits", json={**EDIT_BODY, "source_job_id": str(composite.id)}
        )

    assert response.status_code == 202, response.text
    stored = only_new(repo, seeded)
    assert (stored.source_job_id, stored.root_job_id) == (composite.id, take.id)


async def test_edits_and_composites_take_the_shot_index_of_their_original() -> None:
    """编辑段与合成的镜号不由调用方给，抄基底的；在合成上再剪，仍是原作那一镜。"""

    repo = InMemoryGenerationRepository()
    owner = uuid.uuid4()
    take = seed_take(repo, owner=owner, shot_index=4)
    edit = seed_edit(repo, take)
    composite = make_composite(
        edit, status=STATUS_COMPLETED, owner_user_id=owner, output_url=BASE_URL
    )
    repo.jobs[composite.id] = composite
    app = build_test_app(repo, granted=principal("generation:submit", user_id=owner))
    async with client(app) as http:
        on_take = await http.post(
            "/generations/video-edits", json={**EDIT_BODY, "source_job_id": str(take.id)}
        )
        on_composite = await http.post(
            "/generations/video-edits", json={**EDIT_BODY, "source_job_id": str(composite.id)}
        )
        composed = await http.post(
            "/generations/video-composites", json={"sourceJobId": str(edit.id)}
        )
        named = await http.post(
            "/generations/video-edits",
            json={**EDIT_BODY, "source_job_id": str(take.id), "shot_index": 1},
        )

    assert [
        response.json()["generation"]["shotIndex"] for response in (on_take, on_composite, composed)
    ] == [4, 4, 4]
    assert named.status_code == 422, "编辑段不收镜号"


@pytest.mark.parametrize("flaw", ["不存在", "别人的", "别的对话", "分叉之后才完成"])
@pytest.mark.parametrize("path", ["/generations/video-edits", "/generations/video-composites"])
async def test_a_source_outside_the_conversation_is_one_and_the_same_422(
    flaw: str, path: str
) -> None:
    """不存在、看不见、不在这段对话、继承边界之外，一律同一句，不暴露存在性；不落库。"""

    repo = InMemoryGenerationRepository()
    owner, conversation, parent = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    forked_at = datetime.now(UTC)
    lineage = FixedLineage({conversation: ((parent, forked_at),)})
    if flaw == "不存在":
        source_id = uuid.uuid4()
    else:
        take = seed_take(
            repo,
            owner=uuid.uuid4() if flaw == "别人的" else owner,
            conversation={"别人的": conversation, "别的对话": uuid.uuid4()}.get(flaw, parent),
        )
        source = take if path.endswith("video-edits") else seed_edit(repo, take)
        if flaw == "分叉之后才完成":
            # 同一个人在祖先对话里的，按属主读得到，但完成在分叉之后，不归这段对话。
            source = replace(source, finished_at=forked_at + timedelta(minutes=1))
            repo.jobs[source.id] = source
        source_id = source.id
    seeded = set(repo.jobs)
    body = (
        {**EDIT_BODY, "source_job_id": str(source_id), "conversation_id": str(conversation)}
        if path.endswith("video-edits")
        else {"sourceJobId": str(source_id), "conversationId": str(conversation)}
    )
    app = build_test_app(
        repo, granted=principal("generation:submit", user_id=owner), lineage=lineage
    )
    async with client(app) as http:
        response = await http.post(path, json=body)

    assert response.status_code == 422, response.text
    assert set(repo.jobs) == seeded, "拒绝发生在落库之前"
    detail = response.json()["detail"]
    async with client(app) as http:
        missing = await http.post(
            path,
            json={
                **body,
                ("source_job_id" if path.endswith("video-edits") else "sourceJobId"): str(
                    uuid.uuid4()
                ),
            },
        )
    assert missing.json()["detail"] == detail, "与不存在的那句一字不差"


@pytest.mark.parametrize("role", ["还在跑的出片", "编辑段", "图片"])
async def test_an_edit_needs_a_finished_take_as_its_base(role: str) -> None:
    repo = InMemoryGenerationRepository()
    owner = uuid.uuid4()
    take = seed_take(repo, owner=owner)
    if role == "还在跑的出片":
        base = replace(take, status=STATUS_SUBMITTED, output_url=None)
    elif role == "编辑段":
        base = seed_edit(repo, take)
    else:
        base = make_job(image_request(), status=STATUS_COMPLETED, owner_user_id=owner)
    repo.jobs[base.id] = base
    seeded = set(repo.jobs)
    app = build_test_app(repo, granted=principal("generation:submit", user_id=owner))
    async with client(app) as http:
        response = await http.post(
            "/generations/video-edits", json={**EDIT_BODY, "source_job_id": str(base.id)}
        )

    assert response.status_code == 422, response.text
    assert "成片" in response.json()["detail"]
    assert set(repo.jobs) == seeded


@pytest.mark.parametrize(
    "flaw",
    [
        {"range_start_ms": -1},
        {"range_end_ms": 1000},
        {"model": "atlas-seedance-2-5"},
    ],
    ids=["起点为负", "终点不晚于起点", "模型不在允许表"],
)
async def test_an_edit_with_a_bad_range_or_model_is_rejected(flaw: dict[str, object]) -> None:
    repo = InMemoryGenerationRepository()
    owner = uuid.uuid4()
    take = seed_take(repo, owner=owner)
    app = build_test_app(
        repo, granted=principal("generation:submit", user_id=owner), broken_queue=True
    )
    async with client(app) as http:
        response = await http.post(
            "/generations/video-edits",
            json={**EDIT_BODY, "source_job_id": str(take.id), **flaw},
        )

    assert response.status_code == 422, response.text
    assert list(repo.jobs) == [take.id]


@pytest.mark.parametrize(
    ("range_start_ms", "expected"),
    [
        (
            1000,
            [
                {"url": BASE_URL, "start": 0, "end": 1},
                {"url": EDITED_URL, "start": 0, "end": None},
                {"url": BASE_URL, "start": 4, "end": None},
            ],
        ),
        (
            0,
            [
                {"url": EDITED_URL, "start": 0, "end": None},
                {"url": BASE_URL, "start": 4, "end": None},
            ],
        ),
    ],
    ids=["三段", "从头改起没有前段"],
)
async def test_a_composite_splices_the_edit_back_into_its_base(
    range_start_ms: int, expected: list[dict[str, object]]
) -> None:
    """段按编辑段上记的实际区间算；本地执行，原作随编辑段，来源是编辑段。"""

    repo = InMemoryGenerationRepository()
    owner, conversation = uuid.uuid4(), uuid.uuid4()
    take = seed_take(repo, owner=owner, conversation=conversation)
    edit = seed_edit(repo, take, range_start_ms=range_start_ms)
    app = build_test_app(repo, granted=principal("generation:submit", user_id=owner))
    async with client(app) as http:
        response = await http.post(
            "/generations/video-composites",
            json={"sourceJobId": str(edit.id), "conversationId": str(conversation)},
        )

    assert response.status_code == 202, response.text
    stored = only_new(repo, {take.id, edit.id})
    assert (stored.kind, stored.operation, stored.provider) == ("video", "compose", "ffmpeg")
    assert (stored.source_job_id, stored.root_job_id) == (edit.id, take.id)
    assert (stored.range_start_ms, stored.range_end_ms) == (None, None)
    assert isinstance(stored.request, VideoComposeRequest)
    assert stored.request.model_dump()["segments"] == expected
    assert stored.request.user_name == "tester"
    assert response.json()["generation"]["request"]["userName"] == "tester"


@pytest.mark.parametrize("role", ["出片", "合成", "还在跑的编辑段"])
async def test_a_composite_needs_a_finished_edit_as_its_source(role: str) -> None:
    repo = InMemoryGenerationRepository()
    owner = uuid.uuid4()
    take = seed_take(repo, owner=owner)
    if role == "出片":
        source = take
    elif role == "合成":
        source = make_composite(seed_edit(repo, take), status=STATUS_COMPLETED, owner_user_id=owner)
        repo.jobs[source.id] = source
    else:
        source = seed_edit(repo, take, status=STATUS_SUBMITTED)
    seeded = set(repo.jobs)
    app = build_test_app(repo, granted=principal("generation:submit", user_id=owner))
    async with client(app) as http:
        response = await http.post(
            "/generations/video-composites", json={"sourceJobId": str(source.id)}
        )

    assert response.status_code == 422, response.text
    assert "编辑段" in response.json()["detail"]
    assert set(repo.jobs) == seeded


@pytest.mark.parametrize("path", ["/generations/video-edits", "/generations/video-composites"])
async def test_edits_and_composites_settle_the_author_like_a_take(path: str) -> None:
    """钥匙不报名字就拒；持 users:act_as 的钥匙报了名字，属主换成那个人；浏览器只能报自己。"""

    def body_for(source: GenerationJob, user_name: str | None) -> dict[str, object]:
        if path.endswith("video-edits"):
            body: dict[str, object] = {**EDIT_BODY, "source_job_id": str(source.id)}
            return body if user_name is None else {**body, "user_name": user_name}
        body = {"sourceJobId": str(source.id)}
        return body if user_name is None else {**body, "userName": user_name}

    repo = InMemoryGenerationRepository()
    owner = uuid.uuid4()
    take = seed_take(repo, owner=owner)
    source = take if path.endswith("video-edits") else seed_edit(repo, take)
    seeded = set(repo.jobs)
    key = api_key("generation:submit", ACT_AS_PERMISSION)
    async with client(build_test_app(repo, granted=key)) as http:
        nameless = await http.post(path, json=body_for(source, None))
        acting = await http.post(path, json=body_for(source, "Shan.Hu"))
    async with client(
        build_test_app(repo, granted=principal("generation:submit", user_id=owner))
    ) as http:
        someone_else = await http.post(path, json=body_for(source, "bob"))

    assert nameless.status_code == 422
    assert acting.status_code == 202, acting.text
    stored = only_new(repo, seeded)
    assert stored.owner_user_id not in (key.user_id, owner), "属主换成报上来的那个人"
    assert stored.api_key_id == key.api_key_id
    assert stored.request.model_dump()["user_name"] == "Shan.Hu"
    assert someone_else.status_code == 422


async def test_submit_without_a_conversation_does_not_call_back() -> None:
    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations/video", json=VIDEO_BODY)

    assert response.status_code == 202, response.text
    assert app.state.cleared_completions.calls == []


async def test_composites_are_videos_and_clip_is_no_longer_a_kind() -> None:
    """合成出来的是视频，按种类列视频时在里面；谁执行看操作，``kind=clip`` 不再是合法的筛选。"""

    owner = uuid.uuid4()
    take = make_job(video_request(), owner_user_id=owner, status=STATUS_COMPLETED)
    composite = make_composite(make_edit(take, owner_user_id=owner), owner_user_id=owner)
    repo = InMemoryGenerationRepository([take, composite])
    app = build_test_app(repo, granted=principal("generation:read", user_id=owner))
    async with client(app) as http:
        videos = await http.get("/generations", params={"kind": "video"})
        clips = await http.get("/generations", params={"kind": "clip"})

    assert {(item["id"], item["operation"]) for item in videos.json()["items"]} == {
        (str(take.id), "generate"),
        (str(composite.id), "compose"),
    }
    assert clips.status_code == 422
