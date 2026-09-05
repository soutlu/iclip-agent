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
    StubStyleSnapshots,
    future,
    make_brief,
    make_task,
)

BODY: dict[str, object] = {
    "title": "秋冬新品短视频",
    "styleNo": STYLE_NO,
    "brief": {"theme": "秋冬新品", "requirementDescription": "三十秒的上身效果"},
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
    snapshots: StubStyleSnapshots | None = None,
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

    app.include_router(create_tasks_router(TaskService(repo, snapshots or StubStyleSnapshots())))
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def body_of(task: object, **overrides: object) -> dict[str, object]:

    assert isinstance(task, dict)
    payload = {key: task[key] for key in ("title", "priority", "deadline", "brief")}
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


async def test_style_snapshot_is_frozen_at_creation() -> None:

    repo = InMemoryTaskRepository()
    snapshots = StubStyleSnapshots()
    app = build_test_app(repo, granted=principal("tasks:write", "tasks:read"), snapshots=snapshots)
    async with client(app) as http:
        created = (await http.post("/tasks", json=BODY)).json()["task"]
        assert (
            await http.put(f"/tasks/{created['id']}", json=body_of(created, styleNo="OTHER1"))
        ).status_code == 422
        assert (
            await http.put(
                f"/tasks/{created['id']}", json=body_of(created, style={"styleNo": "OTHER1"})
            )
        ).status_code == 422
        after = (await http.get(f"/tasks/{created['id']}")).json()["task"]

    assert snapshots.asked == [STYLE_NO]
    assert created["style"] == {
        "styleNo": STYLE_NO,
        "brand": "Bruno Marc",
        "category": "高跟鞋",
        "previewImageUrl": "https://cdn.example.com/task-styles/cover.jpg",
    }
    assert after["style"] == created["style"]


async def test_style_nos_default_to_the_primary_style() -> None:

    repo = InMemoryTaskRepository()
    caller = principal("tasks:write")
    async with client(build_test_app(repo, granted=caller)) as http:
        alone = (await http.post("/tasks", json=BODY)).json()["task"]
        many = (
            await http.post(
                "/tasks",
                json={**BODY, "brief": {"styleNos": [STYLE_NO, "OTHER1"]}},
            )
        ).json()["task"]

    assert alone["brief"]["styleNos"] == [STYLE_NO]
    assert many["brief"]["styleNos"] == [STYLE_NO, "OTHER1"]


async def test_editing_a_draft_cannot_drift_from_the_snapshot() -> None:

    task = make_task(brief=make_brief(style_nos=[STYLE_NO]))
    repo = InMemoryTaskRepository([task])
    caller = editor(task.creator_user_id)
    async with client(build_test_app(repo, granted=caller)) as http:
        current = (await http.get(f"/tasks/{task.id}")).json()["task"]

        without = body_of(current, brief={"theme": "换个主题"})
        assert (await http.put(f"/tasks/{task.id}", json=without)).status_code == 200

        drifted = body_of(current, brief={**current["brief"], "styleNos": ["OTHER1"]})
        assert (await http.put(f"/tasks/{task.id}", json=drifted)).status_code == 422

        after = (await http.get(f"/tasks/{task.id}")).json()["task"]

    assert after["brief"]["styleNos"] == [STYLE_NO]


async def test_style_nos_freeze_on_publish() -> None:

    task = make_task(status=STATUS_PUBLISHED, brief=make_brief(style_nos=[STYLE_NO]))
    repo = InMemoryTaskRepository([task])
    async with client(build_test_app(repo, granted=editor())) as http:
        current = (await http.get(f"/tasks/{task.id}")).json()["task"]
        changed = body_of(current, brief={**current["brief"], "styleNos": [STYLE_NO, "OTHER1"]})
        assert (await http.put(f"/tasks/{task.id}", json=changed)).status_code == 409


async def test_creator_cannot_be_supplied_by_the_client() -> None:

    async with client(
        build_test_app(InMemoryTaskRepository(), granted=principal("tasks:write"))
    ) as http:
        response = await http.post("/tasks", json={**BODY, "creatorUserId": str(uuid.uuid4())})
    assert response.status_code == 422


@pytest.mark.parametrize(
    "payload",
    [
        {"title": "", "styleNo": STYLE_NO},
        {"title": "x", "styleNo": STYLE_NO, "brief": {"durationSeconds": 1}},
        {"title": "x", "styleNo": STYLE_NO, "brief": {"ratio": "7:3"}},
        {"title": "x", "styleNo": STYLE_NO, "brief": {"referenceImages": ["file:///etc/passwd"]}},
        {"title": "x", "styleNo": STYLE_NO, "brief": {"unknownField": "x"}},
        {"title": "x"},
        {"title": "x", "styleNo": ""},
        {"title": "x", "styleNo": "NOSUCHSTYLE"},
        {"title": "x", "styleNo": STYLE_NO, "brief": {"styleNos": ["OTHER1", STYLE_NO]}},
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
    payload = {"title": "改个名", "brief": {}}

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


async def test_publishing_needs_a_deadline_and_something_to_make() -> None:
    creator = uuid.uuid4()
    bare = make_task(
        creator_user_id=creator, brief=make_brief(theme="", requirement_description="")
    )
    repo = InMemoryTaskRepository([bare])
    caller = editor(creator)

    async with client(build_test_app(repo, granted=caller)) as http:
        assert (await http.post(f"/tasks/{bare.id}/publish")).status_code == 422
        dated = body_of(
            (await http.get(f"/tasks/{bare.id}")).json()["task"],
            deadline=future().isoformat(),
        )
        assert (await http.put(f"/tasks/{bare.id}", json=dated)).status_code == 200
        assert (await http.post(f"/tasks/{bare.id}/publish")).status_code == 422
        said = body_of(
            (await http.get(f"/tasks/{bare.id}")).json()["task"],
            brief={"requirementDescription": "三十秒的上身效果"},
        )
        assert (await http.put(f"/tasks/{bare.id}", json=said)).status_code == 200
        published = await http.post(f"/tasks/{bare.id}/publish")

    assert published.status_code == 200, published.text
    assert published.json()["task"]["status"] == STATUS_PUBLISHED


async def test_publishing_is_the_creators_call() -> None:
    task = make_task(deadline=future())
    repo = InMemoryTaskRepository([task])
    async with client(build_test_app(repo, granted=principal("tasks:write"))) as http:
        assert (await http.post(f"/tasks/{task.id}/publish")).status_code == 403


async def test_published_input_is_frozen_but_planner_fields_stay_open() -> None:
    """发布后冻结创作输入，仅允许补充规划字段。"""

    task = make_task(status=STATUS_PUBLISHED, brief=make_brief(theme="秋冬新品", purpose="种草"))
    repo = InMemoryTaskRepository([task])
    async with client(build_test_app(repo, granted=editor())) as http:
        current = (await http.get(f"/tasks/{task.id}")).json()["task"]

        frozen = body_of(current, brief={**current["brief"], "purpose": "改成品宣"})
        assert (await http.put(f"/tasks/{task.id}", json=frozen)).status_code == 409

        planner = body_of(
            current,
            title="策划师改的标题",
            brief={**current["brief"], "durationSeconds": 30, "ratio": "9:16"},
        )
        saved = await http.put(f"/tasks/{task.id}", json=planner)

    assert saved.status_code == 200, saved.text
    assert saved.json()["task"]["brief"]["durationSeconds"] == 30
    assert saved.json()["task"]["title"] == "策划师改的标题"


async def test_published_task_must_keep_a_deadline() -> None:
    """在服务层拒绝缺失期限，避免触发数据库 CHECK 后泄漏驱动错误。"""

    task = make_task(status=STATUS_PUBLISHED)
    repo = InMemoryTaskRepository([task])
    async with client(build_test_app(repo, granted=editor())) as http:
        current = (await http.get(f"/tasks/{task.id}")).json()["task"]
        cleared = body_of(current, deadline=None)
        assert (await http.put(f"/tasks/{task.id}", json=cleared)).status_code == 422


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
