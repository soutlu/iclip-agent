"""T-ASSET-01：/uploads/sign 与 /assets 的权限、直传许可与登记规则。

不碰数据库也不碰 OSS：仓储与桶都是内存替身，主体由测试中间件写进
``request.state.principal``。
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from iclip.common.errors import DomainError
from iclip.domains.assets.api import create_assets_router, create_uploads_router
from iclip.domains.assets.models import MAX_BYTES
from iclip.domains.assets.service import AssetService
from iclip.domains.identity.models import Principal
from iclip.platform.http import status_code_for
from tests.helpers.assets import FakeBucket, InMemoryAssetRepository, make_asset


def principal(*permissions: str, user_id: uuid.UUID | None = None) -> Principal:
    return Principal(
        kind="user",
        user_id=user_id or uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="tester",
    )


def editor(user_id: uuid.UUID | None = None) -> Principal:
    return principal("assets:read", "assets:write", user_id=user_id)


def build_test_app(
    repo: InMemoryAssetRepository, bucket: FakeBucket, *, granted: Principal | None
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

    service = AssetService(repo, bucket)
    app.include_router(create_uploads_router(service))
    app.include_router(create_assets_router(service))
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


async def sign(http: httpx.AsyncClient, content_type: str = "image/jpeg") -> httpx.Response:
    return await http.post("/uploads/sign", json={"contentType": content_type})


# --- 权限 ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [("POST", "/uploads/sign"), ("POST", f"/assets/{uuid.uuid4()}"), ("GET", "/assets")],
)
async def test_no_principal_is_unauthorized(method: str, path: str) -> None:
    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=None)
    async with client(app) as http:
        response = await http.request(method, path, json={"contentType": "image/jpeg"})

    assert response.status_code == 401


async def test_reading_does_not_grant_uploading() -> None:
    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=principal("assets:read"))
    async with client(app) as http:
        assert (await sign(http)).status_code == 403
        assert (await http.get("/assets")).status_code == 200


# --- 签名 ---------------------------------------------------------------


async def test_sign_mints_the_name_before_the_bytes_move() -> None:
    """id 必须在传之前就发下来，否则那份已经落进桶里的东西没人认领得了。"""

    bucket = FakeBucket()
    app = build_test_app(InMemoryAssetRepository(), bucket, granted=editor())
    async with client(app) as http:
        response = await sign(http, "video/mp4")

    body = response.json()
    asset_id = uuid.UUID(body["assetId"])
    assert body["upload"]["method"] == "PUT"
    assert body["upload"]["headers"] == {"Content-Type": "video/mp4"}
    # 签的就是那个 id 派生出来的 key，类型一起签进去。
    assert bucket.signed == [(f"iclip/agent/uploads/{asset_id}.mp4", "video/mp4")]
    # 到期时刻要给出来：客户端得知道什么时候这条地址作废、该重新要一条。
    expires_at = datetime.fromisoformat(body["upload"]["expiresAt"])
    assert expires_at > datetime.now(UTC)


async def test_sign_does_not_create_a_row() -> None:
    """签名之后什么都还没发生：拿了地址不传，账本里不该多出一行。"""

    repo = InMemoryAssetRepository()
    app = build_test_app(repo, FakeBucket(), granted=editor())
    async with client(app) as http:
        asset_id = (await sign(http)).json()["assetId"]

        assert repo.assets == {}
        assert (await http.get(f"/assets/{asset_id}")).status_code == 404


@pytest.mark.parametrize("content_type", ["application/pdf", "image/gif", "", "视频"])
async def test_unsupported_types_are_refused_before_signing(content_type: str) -> None:
    bucket = FakeBucket()
    app = build_test_app(InMemoryAssetRepository(), bucket, granted=editor())
    async with client(app) as http:
        response = await sign(http, content_type)

    assert response.status_code == 422
    assert bucket.signed == []


# --- 登记 ---------------------------------------------------------------


async def test_register_copies_the_facts_from_the_bucket() -> None:
    """登记没有请求体：类型、大小、真实 key 全部来自桶。"""

    bucket = FakeBucket()
    repo = InMemoryAssetRepository()
    me = uuid.uuid4()
    app = build_test_app(repo, bucket, granted=editor(me))
    async with client(app) as http:
        asset_id = (await sign(http, "video/mp4")).json()["assetId"]
        bucket.put(f"iclip/agent/uploads/{asset_id}.mp4", content_type="video/mp4", size_bytes=99)

        response = await http.post(f"/assets/{asset_id}")

    asset = response.json()["asset"]
    assert response.status_code == 201
    assert asset["assetType"] == "video"
    assert asset["contentType"] == "video/mp4"
    assert asset["sizeBytes"] == 99
    assert asset["creatorUserId"] == str(me)
    assert asset["url"] == f"https://cdn.test/iclip/agent/uploads/{asset_id}.mp4"


async def test_register_before_the_upload_landed_is_a_conflict() -> None:
    """桶里没有那个对象，就是「还没传上来」——状态冲突，不是参数错。"""

    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=editor())
    async with client(app) as http:
        asset_id = (await sign(http)).json()["assetId"]
        response = await http.post(f"/assets/{asset_id}")

    assert response.status_code == 409


async def test_register_is_idempotent() -> None:
    """登记是客户端传完之后自己发起的，它断线重试是正常路径。"""

    bucket = FakeBucket()
    repo = InMemoryAssetRepository()
    app = build_test_app(repo, bucket, granted=editor())
    async with client(app) as http:
        asset_id = (await sign(http)).json()["assetId"]
        bucket.put(f"iclip/agent/uploads/{asset_id}.jpg", content_type="image/jpeg")

        first = await http.post(f"/assets/{asset_id}")
        again = await http.post(f"/assets/{asset_id}")

    assert first.json() == again.json()
    assert len(repo.assets) == 1


async def test_oversized_upload_gets_no_row() -> None:
    """上限只在这一步卡得住（预签名 PUT 限不住长度）：字节进了桶，但拿不到账本上的行。"""

    bucket = FakeBucket()
    repo = InMemoryAssetRepository()
    app = build_test_app(repo, bucket, granted=editor())
    async with client(app) as http:
        asset_id = (await sign(http)).json()["assetId"]
        bucket.put(
            f"iclip/agent/uploads/{asset_id}.jpg",
            content_type="image/jpeg",
            size_bytes=MAX_BYTES["image"] + 1,
        )

        response = await http.post(f"/assets/{asset_id}")

    assert response.status_code == 422
    assert repo.assets == {}


async def test_registering_a_name_nobody_signed_is_a_conflict() -> None:
    """猜一个 id 来登记：桶里没有对应对象，走的还是「还没传上来」那条。"""

    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=editor())
    async with client(app) as http:
        response = await http.post(f"/assets/{uuid.uuid4()}")

    assert response.status_code == 409


# --- 读 -----------------------------------------------------------------


async def test_everyone_sees_everything() -> None:
    """素材是全公司共用的：不做归属过滤，creatorUserId 只是查询维度。"""

    mine = make_asset(creator_user_id=uuid.uuid4(), object_key="iclip/agent/uploads/a.jpg")
    theirs = make_asset(
        creator_user_id=uuid.uuid4(), object_key="iclip/agent/uploads/b.mp4", asset_type="video"
    )
    repo = InMemoryAssetRepository([mine, theirs])
    app = build_test_app(repo, FakeBucket(), granted=principal("assets:read"))
    async with client(app) as http:
        listed = (await http.get("/assets")).json()["items"]
        filtered = (
            await http.get("/assets", params={"creatorUserId": str(theirs.creator_user_id)})
        ).json()["items"]
        by_type = (await http.get("/assets", params={"assetType": "image"})).json()["items"]

    assert {item["id"] for item in listed} == {str(mine.id), str(theirs.id)}
    assert [item["id"] for item in filtered] == [str(theirs.id)]
    assert [item["id"] for item in by_type] == [str(mine.id)]


async def test_url_is_composed_not_stored() -> None:
    """库里存的是 key；换一个公网前缀，同一行读出来就是另一个地址。"""

    asset = make_asset(object_key="iclip/agent/uploads/a.jpg")
    repo = InMemoryAssetRepository([asset])
    app = build_test_app(repo, FakeBucket(base="https://cdn.new"), granted=principal("assets:read"))
    async with client(app) as http:
        body = (await http.get(f"/assets/{asset.id}")).json()

    assert body["asset"]["url"] == "https://cdn.new/iclip/agent/uploads/a.jpg"


async def test_unknown_asset_is_not_found() -> None:
    app = build_test_app(InMemoryAssetRepository(), FakeBucket(), granted=principal("assets:read"))
    async with client(app) as http:
        assert (await http.get(f"/assets/{uuid.uuid4()}")).status_code == 404
