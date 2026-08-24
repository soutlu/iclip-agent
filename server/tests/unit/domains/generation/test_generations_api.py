"""T-GEN-05：/generations 的权限、错误映射与受理语义。

不碰数据库：仓储用内存替身，主体由测试中间件写进 ``request.state.principal``。
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

import httpx
import pytest
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from iclip.common.errors import DomainError
from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.models import STATUS_PENDING
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
        # 队列连不上（数据库那半边挂了）时该怎么办。
        async def _boom(_job: object) -> None:
            raise RuntimeError("排队失败")

        queue.enqueue_submit = _boom  # type: ignore[method-assign]
    service = GenerationService(
        repo, queue, video_provider_name="multiflow", image_provider_name="nano_banana_pro"
    )
    app.include_router(create_generations_router(service))
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


async def test_submit_accepts_and_persists_pending_without_calling_provider() -> None:
    """202 的含义是「受理了」：库里有行，但还没碰过 provider。"""

    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"))
    async with client(app) as http:
        response = await http.post("/generations", json=VIDEO_BODY)

    assert response.status_code == 202
    body = response.json()["generation"]
    assert body["status"] == STATUS_PENDING
    assert body["provider"] == "multiflow"
    assert body["outputUrl"] is None
    assert len(repo.jobs) == 1


async def test_submit_records_the_api_key_that_did_it() -> None:
    """谁的 key 干的永远可追（不变量 4）。"""

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
    """请求体里的 ownerUserId 一类字段进不来：多余字段直接 422。"""

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


async def test_submit_requires_the_submit_permission() -> None:
    repo = InMemoryGenerationRepository()
    async with client(build_test_app(repo, granted=principal("generation:read"))) as http:
        assert (await http.post("/generations", json=VIDEO_BODY)).status_code == 403
    async with client(build_test_app(repo, granted=None)) as http:
        assert (await http.post("/generations", json=VIDEO_BODY)).status_code == 401


async def test_reading_someone_elses_generation_is_a_404() -> None:
    """不可见资源返回 404，不泄露它存不存在（不变量 8）。"""

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


async def test_list_rejects_out_of_range_limit() -> None:
    app = build_test_app(InMemoryGenerationRepository(), granted=principal("generation:read"))
    async with client(app) as http:
        assert (await http.get("/generations?limit=0")).status_code == 422
        assert (await http.get("/generations?limit=1000")).status_code == 422


async def test_response_hides_provider_snapshot_and_queue_mechanics() -> None:
    """provider 原始快照里带着签名 URL，租约与尝试次数是内部机制，都不外泄。"""

    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    owner = principal("generation:read", user_id=job.owner_user_id)
    async with client(build_test_app(repo, granted=owner)) as http:
        body = (await http.get(f"/generations/{job.id}")).json()["generation"]

    hidden = {"providerSnapshot", "providerTaskId", "leaseOwner", "attempts", "nextAttemptAt"}
    assert hidden.isdisjoint(body)


async def test_failing_to_enqueue_fails_the_row_instead_of_leaving_it_pending() -> None:
    """落行和排队是两个驱动两个事务，做不到原子。排队失败要照实说。

    留一个「永远 pending」的行更糟：那看起来像还在排队，而其实永远不会有人做它。
    """

    repo = InMemoryGenerationRepository()
    app = build_test_app(repo, granted=principal("generation:submit"), broken_queue=True)
    async with client(app) as http:
        # 错误照原样往上抛（线上由 uvicorn 变成 500）：不假装受理成功了。
        with pytest.raises(RuntimeError, match="排队失败"):
            await http.post("/generations", json=VIDEO_BODY)

    (stored,) = list(repo.jobs.values())
    assert stored.status == "failed"
    assert stored.error_code == "QUEUE_DEFER_FAILED"
