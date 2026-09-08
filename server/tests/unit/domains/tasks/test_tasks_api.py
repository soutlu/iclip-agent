"""使用内存仓储验证 /tasks 权限、状态机和冻结规则；身份由测试中间件注入。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

import httpx
import pytest
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from iclip.common.errors import DomainError
from iclip.domains.identity.models import Principal
from iclip.domains.tasks.api import create_tasks_router
from iclip.domains.tasks.models import (
    STATUS_CONFIRMED,
    STATUS_DRAFT,
    STATUS_PUBLISHED,
    STATUS_WITHDRAWN,
)
from iclip.domains.tasks.service import TaskService
from iclip.platform.http import status_code_for
from tests.helpers.tasks import (
    STYLE_NO,
    InMemoryTaskRepository,
    future,
    make_inputs,
    make_task,
)

BODY: dict[str, object] = {
    "title": "秋冬新品短视频",
    "inputs": make_inputs().model_dump(),
}


def editor(user_id: uuid.UUID | None = None, *extra: str) -> Principal:
    """预置 editor 同时持有这两个权限，真实角色表中不存在只授予其一的角色。"""

    return principal("tasks:read", "tasks:write", *extra, user_id=user_id)


def principal(*permissions: str, user_id: uuid.UUID | None = None) -> Principal:
    return Principal(
        kind="user",
        user_id=user_id or uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="tester",
    )


def build_test_app(
    repo: InMemoryTaskRepository,
    *,
    granted: Principal | None,
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

    app.include_router(create_tasks_router(TaskService(repo)))
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def body_of(task: object, **overrides: object) -> dict[str, object]:

    assert isinstance(task, dict)
    payload = {key: task[key] for key in ("title", "priority", "deadline", "inputs")}
    payload.update(overrides)
    return payload


async def test_creating_lands_a_draft_owned_by_the_caller() -> None:

    repo = InMemoryTaskRepository()
    caller = principal("tasks:write")
    async with client(build_test_app(repo, granted=caller)) as http:
        response = await http.post("/tasks", json=BODY)

    assert response.status_code == 201, response.text
    task = response.json()["task"]
    assert task["status"] == STATUS_DRAFT
    assert task["creatorUserId"] == str(caller.user_id)
    assert task["deadline"] is None


async def test_client_minted_id_lands_published_and_repeats_idempotently() -> None:
    """机器链路自带 id 直接落已下发状态；重发同一个 id 不会多出第二张单。"""

    minted = uuid.uuid4()
    repo = InMemoryTaskRepository()
    async with client(build_test_app(repo, granted=principal("tasks:write"))) as http:
        first = await http.post("/tasks", json={**BODY, "id": str(minted), "status": "published"})
        second = await http.post(
            "/tasks", json={**BODY, "id": str(minted), "status": "published", "title": "另一个标题"}
        )

    assert first.status_code == 201, first.text
    assert first.json()["task"]["id"] == str(minted)
    assert first.json()["task"]["status"] == STATUS_PUBLISHED
    assert second.status_code == 200, second.text
    assert second.json()["task"]["title"] == BODY["title"]
    assert list(repo.tasks) == [minted]


@pytest.mark.parametrize("status", ["confirmed", "withdrawn", "", "PUBLISHED"])
async def test_creation_only_accepts_draft_or_published(status: str) -> None:

    async with client(
        build_test_app(InMemoryTaskRepository(), granted=principal("tasks:write"))
    ) as http:
        response = await http.post("/tasks", json={**BODY, "status": status})
    assert response.status_code == 422


async def test_status_cannot_be_supplied_when_overwriting() -> None:
    """状态只在创建时可选，之后一律走状态机端点。"""

    task = make_task()
    repo = InMemoryTaskRepository([task])
    async with client(build_test_app(repo, granted=editor(task.creator_user_id))) as http:
        current = (await http.get(f"/tasks/{task.id}")).json()["task"]
        response = await http.put(
            f"/tasks/{task.id}", json=body_of(current, status=STATUS_PUBLISHED)
        )
    assert response.status_code == 422


async def test_draft_product_is_editable_except_for_its_style_number() -> None:
    task = make_task()
    repo = InMemoryTaskRepository([task])
    async with client(build_test_app(repo, granted=editor(task.creator_user_id))) as http:
        current = (await http.get(f"/tasks/{task.id}")).json()["task"]
        inputs = current["inputs"]
        inputs["product"].update(name="及膝长靴", image_oss_urls=["https://example.com/boots.jpg"])
        saved = await http.put(f"/tasks/{task.id}", json=body_of(current, inputs=inputs))
        assert saved.status_code == 200
        assert saved.json()["task"]["inputs"]["product"] == inputs["product"]
        inputs["product"]["style_no"] = "OTHER1"
        assert (
            await http.put(f"/tasks/{task.id}", json=body_of(current, inputs=inputs))
        ).status_code == 409
        after = (await http.get(f"/tasks/{task.id}")).json()["task"]
        assert after["inputs"]["product"]["style_no"] == STYLE_NO


@pytest.mark.parametrize("field", ["name", "image_oss_urls"])
async def test_product_freezes_on_publish(field: str) -> None:
    task = make_task(status=STATUS_PUBLISHED)
    repo = InMemoryTaskRepository([task])
    async with client(build_test_app(repo, granted=editor())) as http:
        current = (await http.get(f"/tasks/{task.id}")).json()["task"]
        current["inputs"]["product"][field] = (
            ["https://example.com/new.jpg"] if field == "image_oss_urls" else "new name"
        )
        assert (await http.put(f"/tasks/{task.id}", json=body_of(current))).status_code == 409


async def test_creator_cannot_be_supplied_by_the_client() -> None:

    async with client(
        build_test_app(InMemoryTaskRepository(), granted=principal("tasks:write"))
    ) as http:
        response = await http.post("/tasks", json={**BODY, "creatorUserId": str(uuid.uuid4())})
    assert response.status_code == 422


@pytest.mark.parametrize(
    "payload",
    [
        {**BODY, "title": ""},
        {
            **BODY,
            "inputs": {"product": {"style_no": STYLE_NO}, "video_spec": {"duration_seconds": 1}},
        },
        {
            **BODY,
            "inputs": {"product": {"style_no": STYLE_NO}, "video_spec": {"aspect_ratio": "7:3"}},
        },
        {
            **BODY,
            "inputs": {"product": {"style_no": STYLE_NO, "image_oss_urls": ["file:///etc/passwd"]}},
        },
        {
            **BODY,
            "inputs": {
                "product": {"style_no": STYLE_NO},
                "reference_image_oss_urls": {"model": ["https://"]},
            },
        },
        {
            **BODY,
            "inputs": {
                "product": {"style_no": STYLE_NO},
                "reference_video_oss_url": "file:///video.mp4",
            },
        },
        {**BODY, "inputs": {"product": {"style_no": STYLE_NO}, "unknown_field": "x"}},
        {"title": "x"},
        {**BODY, "inputs": {"product": {"style_no": ""}}},
        {**BODY, "inputs": {"product": {"style_no": "   "}}},
    ],
)
async def test_bad_request_shapes_are_rejected(payload: dict[str, object]) -> None:
    async with client(
        build_test_app(InMemoryTaskRepository(), granted=principal("tasks:write"))
    ) as http:
        assert (await http.post("/tasks", json=payload)).status_code == 422


async def test_permissions_gate_the_two_kinds_of_access() -> None:
    task = make_task()
    repo = InMemoryTaskRepository([task])

    async with client(build_test_app(repo, granted=None)) as http:
        assert (await http.get("/tasks")).status_code == 401
    async with client(build_test_app(repo, granted=principal("tasks:read"))) as http:
        assert (await http.get("/tasks")).status_code == 200
        assert (await http.post("/tasks", json=BODY)).status_code == 403


async def test_everyone_sees_every_task() -> None:

    task = make_task()
    repo = InMemoryTaskRepository([task])
    async with client(build_test_app(repo, granted=principal("tasks:read"))) as http:
        assert (await http.get(f"/tasks/{task.id}")).status_code == 200
        assert len((await http.get("/tasks")).json()["items"]) == 1
        assert (await http.get(f"/tasks/{uuid.uuid4()}")).status_code == 404


async def test_a_draft_is_the_creators_own_business() -> None:

    task = make_task()
    repo = InMemoryTaskRepository([task])
    payload = {"title": "改个名", "inputs": make_inputs().model_dump()}

    async with client(build_test_app(repo, granted=principal("tasks:write"))) as http:
        assert (await http.put(f"/tasks/{task.id}", json=payload)).status_code == 403
        assert (await http.delete(f"/tasks/{task.id}")).status_code == 403

    manager = principal("tasks:write", "users:manage")
    async with client(build_test_app(repo, granted=manager)) as http:
        assert (await http.put(f"/tasks/{task.id}", json=payload)).status_code == 200

    owner = principal("tasks:write", user_id=task.creator_user_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        assert (await http.delete(f"/tasks/{task.id}")).status_code == 204
    assert repo.tasks == {}


async def test_publishing_needs_something_to_make_but_no_deadline() -> None:
    creator = uuid.uuid4()
    bare = make_task(creator_user_id=creator, inputs=make_inputs(creative_requirement=""))
    repo = InMemoryTaskRepository([bare])
    caller = editor(creator)

    async with client(build_test_app(repo, granted=caller)) as http:
        assert (await http.post(f"/tasks/{bare.id}/publish")).status_code == 422
        said = body_of(
            (await http.get(f"/tasks/{bare.id}")).json()["task"],
            inputs=make_inputs().model_dump(),
        )
        assert (await http.put(f"/tasks/{bare.id}", json=said)).status_code == 200
        published = await http.post(f"/tasks/{bare.id}/publish")

    assert published.status_code == 200, published.text
    assert published.json()["task"]["status"] == STATUS_PUBLISHED
    assert published.json()["task"]["deadline"] is None


async def test_publishing_is_the_creators_call() -> None:
    task = make_task(deadline=future())
    repo = InMemoryTaskRepository([task])
    async with client(build_test_app(repo, granted=principal("tasks:write"))) as http:
        assert (await http.post(f"/tasks/{task.id}/publish")).status_code == 403


@pytest.mark.parametrize("field", ["platform", "video_type", "content_type"])
async def test_published_input_is_frozen_but_planner_fields_stay_open(field: str) -> None:
    task = make_task(status=STATUS_PUBLISHED)
    repo = InMemoryTaskRepository([task])
    async with client(build_test_app(repo, granted=editor())) as http:
        current = (await http.get(f"/tasks/{task.id}")).json()["task"]
        inputs = current["inputs"]
        inputs["video_spec"][field] = "changed"
        assert (await http.put(f"/tasks/{task.id}", json=body_of(current))).status_code == 409
        inputs["video_spec"][field] = ""
        inputs["video_spec"].update(duration_seconds=30, aspect_ratio="9:16", resolution="1080p")
        inputs["creative_requirement"] = "新创作要求"
        inputs["reference_image_oss_urls"] = {
            "model": ["https://example.com/model.jpg"],
            "outfit": ["https://example.com/outfit.jpg"],
            "prop": ["https://example.com/prop.jpg"],
        }
        inputs["reference_video_oss_url"] = "https://example.com/video.mp4"
        saved = await http.put(f"/tasks/{task.id}", json=body_of(current, title="策划师改的标题"))
    assert saved.status_code == 200, saved.text
    assert saved.json()["task"]["inputs"] == inputs
    assert saved.json()["task"]["title"] == "策划师改的标题"


async def test_published_task_may_have_no_deadline() -> None:
    """期限始终可选：机器提交的需求单不带期限，策划仍能继续编辑它。"""

    task = make_task(status=STATUS_PUBLISHED)
    repo = InMemoryTaskRepository([task])
    async with client(build_test_app(repo, granted=editor())) as http:
        current = (await http.get(f"/tasks/{task.id}")).json()["task"]
        cleared = body_of(current, deadline=None)
        saved = await http.put(f"/tasks/{task.id}", json=cleared)

    assert saved.status_code == 200, saved.text
    assert saved.json()["task"]["deadline"] is None


@pytest.mark.parametrize(
    ("status", "action", "expected"),
    [
        (STATUS_DRAFT, "confirm", 409),
        (STATUS_DRAFT, "withdraw", 409),
        (STATUS_PUBLISHED, "publish", 409),
        (STATUS_CONFIRMED, "confirm", 200),
        (STATUS_CONFIRMED, "publish", 409),
        (STATUS_WITHDRAWN, "confirm", 409),
        (STATUS_WITHDRAWN, "withdraw", 409),
        (STATUS_PUBLISHED, "confirm", 200),
        (STATUS_PUBLISHED, "withdraw", 200),
        (STATUS_CONFIRMED, "withdraw", 200),
    ],
)
async def test_illegal_transitions_are_conflicts(status: str, action: str, expected: int) -> None:

    task = make_task(status=status, deadline=future())  # type: ignore[arg-type]
    repo = InMemoryTaskRepository([task])
    caller = editor(task.creator_user_id)
    async with client(build_test_app(repo, granted=caller)) as http:
        assert (await http.post(f"/tasks/{task.id}/{action}")).status_code == expected


@pytest.mark.parametrize("status", [STATUS_PUBLISHED, STATUS_CONFIRMED, STATUS_WITHDRAWN])
async def test_only_drafts_can_be_deleted(status: str) -> None:
    """已发布需求单通过撤回留痕，不能直接删除。"""

    task = make_task(status=status, deadline=future())  # type: ignore[arg-type]
    repo = InMemoryTaskRepository([task])
    caller = editor(task.creator_user_id, "users:manage")
    async with client(build_test_app(repo, granted=caller)) as http:
        assert (await http.delete(f"/tasks/{task.id}")).status_code == 409
    assert task.id in repo.tasks


async def test_withdrawn_tasks_are_frozen_solid() -> None:
    task = make_task(status=STATUS_WITHDRAWN, deadline=future())
    repo = InMemoryTaskRepository([task])
    caller = editor(task.creator_user_id, "users:manage")
    async with client(build_test_app(repo, granted=caller)) as http:
        current = (await http.get(f"/tasks/{task.id}")).json()["task"]
        assert (await http.put(f"/tasks/{task.id}", json=body_of(current))).status_code == 409


async def test_list_filters_by_status_and_rejects_out_of_range_limit() -> None:
    repo = InMemoryTaskRepository(
        [make_task(), make_task(status=STATUS_PUBLISHED, deadline=future())]
    )
    async with client(build_test_app(repo, granted=principal("tasks:read"))) as http:
        assert len((await http.get("/tasks")).json()["items"]) == 2
        assert len((await http.get(f"/tasks?status={STATUS_DRAFT}")).json()["items"]) == 1
        assert (await http.get("/tasks?status=nonsense")).status_code == 422
        assert (await http.get("/tasks?limit=0")).status_code == 422
        assert (await http.get("/tasks?limit=1000")).status_code == 422


async def test_confirm_records_who_claimed() -> None:

    task = make_task(status=STATUS_PUBLISHED, deadline=future())
    repo = InMemoryTaskRepository([task])
    caller = editor()
    async with client(build_test_app(repo, granted=caller)) as http:
        confirmed = await http.post(f"/tasks/{task.id}/confirm")

        assert confirmed.status_code == 200
        assert confirmed.json()["task"]["assigneeUserIds"] == [str(caller.user_id)]


async def test_multiple_people_can_claim_the_same_task() -> None:

    first = editor()
    task = make_task(status=STATUS_CONFIRMED, deadline=future(), assignee_user_ids=(first.user_id,))
    repo = InMemoryTaskRepository([task])
    second = editor()
    async with client(build_test_app(repo, granted=second)) as http:
        confirmed = await http.post(f"/tasks/{task.id}/confirm")

        assert confirmed.status_code == 200
        assert confirmed.json()["task"]["assigneeUserIds"] == [
            str(first.user_id),
            str(second.user_id),
        ]

    async with client(build_test_app(repo, granted=second)) as http:
        again = await http.post(f"/tasks/{task.id}/confirm")
        assert again.json()["task"]["assigneeUserIds"] == [
            str(first.user_id),
            str(second.user_id),
        ]


async def test_claimed_by_me_lists_only_my_claims() -> None:

    me = editor()
    mine = make_task(status=STATUS_CONFIRMED, deadline=future(), assignee_user_ids=(me.user_id,))
    other = make_task(status=STATUS_CONFIRMED, deadline=future(), assignee_user_ids=(uuid.uuid4(),))
    nobody = make_task(status=STATUS_PUBLISHED, deadline=future())
    repo = InMemoryTaskRepository([mine, other, nobody])
    async with client(build_test_app(repo, granted=me)) as http:
        items = (await http.get("/tasks?claimedBy=me")).json()["items"]
        assert [item["id"] for item in items] == [str(mine.id)]
        assert (await http.get("/tasks?claimedBy=someone-else")).status_code == 422


@pytest.mark.parametrize(
    "media",
    [
        {"product": {"style_no": STYLE_NO, "image_oss_urls": ["https://example.com/product.jpg"]}},
        {"reference_image_oss_urls": {"model": ["https://example.com/model.jpg"]}},
        {"reference_image_oss_urls": {"outfit": ["https://example.com/outfit.jpg"]}},
        {"reference_image_oss_urls": {"prop": ["https://example.com/prop.jpg"]}},
        {"reference_video_oss_url": "https://example.com/video.mp4"},
    ],
)
async def test_a_supplied_creative_asset_is_enough_to_publish(media: dict[str, object]) -> None:
    task = make_task(deadline=future(), inputs=make_inputs(creative_requirement="", **media))
    async with client(
        build_test_app(InMemoryTaskRepository([task]), granted=editor(task.creator_user_id))
    ) as http:
        response = await http.post(f"/tasks/{task.id}/publish")
    assert response.status_code == 200, response.text
