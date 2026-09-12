"""使用 bucket 替身验证上传签名、审计头、权限和确认规则。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from iclip.common.errors import DomainError
from iclip.domains.identity.models import Principal
from iclip.domains.uploads.api import create_uploads_router
from iclip.domains.uploads.models import MAX_BYTES, MAX_LONG_EDGE_PIXELS, MIN_SHORT_EDGE_PIXELS
from iclip.domains.uploads.service import API_KEY_HEADER, UPLOADER_HEADER, UploadService
from iclip.platform.http import status_code_for
from tests.helpers.uploads import FakeBucket


def uploader(user_id: uuid.UUID | None = None, *, api_key_id: uuid.UUID | None = None) -> Principal:
    return Principal(
        kind="user" if api_key_id is None else "api_key",
        user_id=user_id or uuid.uuid4(),
        permissions=frozenset({"uploads:write"}),
        audit_label="tester",
        api_key_id=api_key_id,
    )


def build_test_app(bucket: FakeBucket, *, granted: Principal | None) -> FastAPI:
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

    app.include_router(create_uploads_router(UploadService(bucket)))
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


async def sign(
    http: httpx.AsyncClient,
    content_type: str = "image/jpeg",
    *,
    width: int | None = 1200,
    height: int | None = 1600,
) -> httpx.Response:
    body: dict[str, object] = {"contentType": content_type}
    if width is not None:
        body["width"] = width
    if height is not None:
        body["height"] = height
    return await http.post("/uploads/sign", json=body)


async def confirm(http: httpx.AsyncClient, upload_id: str) -> httpx.Response:
    return await http.post(f"/uploads/{upload_id}/confirm")


@pytest.mark.parametrize("path", ["/uploads/sign", f"/uploads/{uuid.uuid4()}/confirm"])
async def test_no_principal_is_unauthorized(path: str) -> None:
    app = build_test_app(FakeBucket(), granted=None)
    async with client(app) as http:
        response = await http.post(path, json={"contentType": "image/jpeg"})

    assert response.status_code == 401


async def test_both_steps_need_uploads_write() -> None:
    reader = Principal(
        kind="user",
        user_id=uuid.uuid4(),
        permissions=frozenset({"inspirations:read"}),
        audit_label="tester",
    )
    app = build_test_app(FakeBucket(), granted=reader)
    async with client(app) as http:
        assert (await sign(http)).status_code == 403
        assert (await confirm(http, str(uuid.uuid4()))).status_code == 403


async def test_sign_mints_the_name_and_signs_the_uploader_in() -> None:
    """名字在字节落地前发下来；上传者签进请求头，浏览器原样带上才能通过验签。"""

    bucket = FakeBucket()
    me = uuid.uuid4()
    app = build_test_app(bucket, granted=uploader(me))
    async with client(app) as http:
        response = await sign(http, "video/mp4")

    body = response.json()
    upload_id = uuid.UUID(body["uploadId"])
    headers = {"Content-Type": "video/mp4", UPLOADER_HEADER: str(me)}
    assert body["upload"]["method"] == "PUT"
    assert body["upload"]["headers"] == headers
    assert body["upload"]["url"] == f"https://cdn.test/iclip/agent/uploads/{upload_id}.mp4?signed"
    assert bucket.signed == [(f"iclip/agent/uploads/{upload_id}.mp4", headers)]
    assert datetime.fromisoformat(body["upload"]["expiresAt"]) > datetime.now(UTC)


async def test_key_uploads_also_sign_the_key_in() -> None:
    bucket = FakeBucket()
    me, key = uuid.uuid4(), uuid.uuid4()
    app = build_test_app(bucket, granted=uploader(me, api_key_id=key))
    async with client(app) as http:
        body = (await sign(http)).json()

    assert body["upload"]["headers"] == {
        "Content-Type": "image/jpeg",
        UPLOADER_HEADER: str(me),
        API_KEY_HEADER: str(key),
    }
    assert bucket.signed[0][1] == body["upload"]["headers"]


@pytest.mark.parametrize("content_type", ["application/pdf", "image/gif", "", "视频"])
async def test_unsupported_types_are_refused_before_signing(content_type: str) -> None:
    bucket = FakeBucket()
    app = build_test_app(bucket, granted=uploader())
    async with client(app) as http:
        response = await sign(http, content_type)

    assert response.status_code == 422
    assert bucket.signed == []


@pytest.mark.parametrize(
    ("width", "height"),
    [
        (MIN_SHORT_EDGE_PIXELS - 1, 4000),
        (4000, MIN_SHORT_EDGE_PIXELS - 1),
        (MAX_LONG_EDGE_PIXELS + 1, 4000),
        (4000, MAX_LONG_EDGE_PIXELS + 1),
    ],
)
async def test_out_of_range_images_are_refused_before_signing(width: int, height: int) -> None:
    bucket = FakeBucket()
    app = build_test_app(bucket, granted=uploader())
    async with client(app) as http:
        response = await sign(http, width=width, height=height)

    assert response.status_code == 422
    assert bucket.signed == []


@pytest.mark.parametrize(
    ("width", "height"),
    [(MIN_SHORT_EDGE_PIXELS, MIN_SHORT_EDGE_PIXELS), (MAX_LONG_EDGE_PIXELS, MAX_LONG_EDGE_PIXELS)],
)
async def test_the_bounds_themselves_pass(width: int, height: int) -> None:
    app = build_test_app(FakeBucket(), granted=uploader())
    async with client(app) as http:
        assert (await sign(http, width=width, height=height)).status_code == 200


async def test_an_image_must_report_its_size() -> None:
    app = build_test_app(FakeBucket(), granted=uploader())
    async with client(app) as http:
        assert (await sign(http, width=None, height=None)).status_code == 422
        assert (await sign(http, width=1200, height=None)).status_code == 422


async def test_video_needs_no_size() -> None:
    app = build_test_app(FakeBucket(), granted=uploader())
    async with client(app) as http:
        assert (await sign(http, "video/mp4", width=None, height=None)).status_code == 200


async def test_confirm_answers_from_the_bucket_and_can_be_repeated() -> None:
    """确认只交回地址与桶里读到的事实；每次都重新回答，重试拿到同一份。"""

    bucket = FakeBucket()
    app = build_test_app(bucket, granted=uploader())
    async with client(app) as http:
        upload_id = (await sign(http, "video/mp4")).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.mp4", content_type="video/mp4", size_bytes=99)

        first = await confirm(http, upload_id)
        again = await confirm(http, upload_id)

    assert first.status_code == 200
    assert first.json() == {
        "url": f"https://cdn.test/iclip/agent/uploads/{upload_id}.mp4",
        "contentType": "video/mp4",
        "sizeBytes": 99,
    }
    assert again.json() == first.json()


async def test_confirm_before_the_upload_landed_is_a_conflict() -> None:
    app = build_test_app(FakeBucket(), granted=uploader())
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        assert (await confirm(http, upload_id)).status_code == 409
        assert (await confirm(http, str(uuid.uuid4()))).status_code == 409


async def test_oversized_upload_is_refused() -> None:
    """预签名 PUT 无法限制长度，确认时须校验桶内实际大小。"""

    bucket = FakeBucket()
    app = build_test_app(bucket, granted=uploader())
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(
            f"iclip/agent/uploads/{upload_id}.jpg",
            content_type="image/jpeg",
            size_bytes=MAX_BYTES["image"] + 1,
        )
        response = await confirm(http, upload_id)

    assert response.status_code == 422


async def test_unexpected_type_in_the_bucket_is_refused() -> None:
    """Content-Type 签进了签名里，桶里仍可能出现别的类型（改过 CORS 或 SDK 直传），确认时按桶里的算。"""

    bucket = FakeBucket()
    app = build_test_app(bucket, granted=uploader())
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.jpg", content_type="application/pdf")
        response = await confirm(http, upload_id)

    assert response.status_code == 422
