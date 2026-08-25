"""T-UPLOAD-01：上传口的权限、两道闸门与幂等。

不碰真存储：``PublicObjectStore`` 的内存替身记下写了什么 key、什么类型（和生成域的
用例共用同一个替身）。这里验的是「什么收、什么拒、同一份内容落到哪」。
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Awaitable, Callable

import httpx
import pytest
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from iclip.common.errors import DomainError
from iclip.domains.identity.models import Principal
from iclip.domains.uploads import api as uploads_api
from iclip.domains.uploads.api import create_uploads_router
from iclip.platform.http import status_code_for
from iclip.platform.object_store.oss import ObjectStoreUnavailable
from tests.helpers.generation import MemoryObjectStore

URL = "/uploads"
JPEG = b"\xff\xd8\xff\xe0 pretend this is a photo"


def principal(*permissions: str) -> Principal:
    return Principal(
        kind="user",
        user_id=uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="tester",
    )


def build_test_app(store: object, *, granted: Principal | None) -> FastAPI:
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

    app.include_router(create_uploads_router(store))  # type: ignore[arg-type]
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def upload(content: bytes = JPEG, *, content_type: str = "image/jpeg", name: str = "a.jpg"):
    return {"file": (name, content, content_type)}


async def test_uploading_returns_a_public_address() -> None:
    """产物就是一个地址；对象 key 由内容的哈希派生，类型按声明写进存储。"""

    store = MemoryObjectStore()
    async with client(build_test_app(store, granted=principal("assets:write"))) as http:
        response = await http.post(URL, files=upload())

    assert response.status_code == 201, response.text
    digest = hashlib.sha256(JPEG).hexdigest()
    assert response.json()["upload"] == {
        "url": f"{store.base}/uploads/{digest}.jpg",
        "contentType": "image/jpeg",
    }
    assert store.objects[f"uploads/{digest}.jpg"] == (JPEG, "image/jpeg")


async def test_the_same_file_lands_on_the_same_address() -> None:
    """同内容同 key：重复传一份不多占空间，也不多出第二个地址。"""

    store = MemoryObjectStore()
    async with client(build_test_app(store, granted=principal("assets:write"))) as http:
        first = await http.post(URL, files=upload())
        # 文件名换了也不影响：名字是用户输入，不参与命名。
        second = await http.post(URL, files=upload(name="另一个名字.jpg"))

    assert first.json()["upload"]["url"] == second.json()["upload"]["url"]
    assert len(store.objects) == 1


async def test_the_client_filename_never_reaches_the_object_key() -> None:
    """后缀从 content type 查表，不从文件名取——否则命名权就交到外面去了。"""

    store = MemoryObjectStore()
    async with client(build_test_app(store, granted=principal("assets:write"))) as http:
        await http.post(URL, files=upload(name="../../escape.sh", content_type="image/png"))

    assert list(store.objects) == [f"uploads/{hashlib.sha256(JPEG).hexdigest()}.png"]


async def test_permission_gates_the_endpoint() -> None:
    store = MemoryObjectStore()
    async with client(build_test_app(store, granted=None)) as http:
        assert (await http.post(URL, files=upload())).status_code == 401
    async with client(build_test_app(store, granted=principal("assets:read"))) as http:
        assert (await http.post(URL, files=upload())).status_code == 403
    assert store.objects == {}


@pytest.mark.parametrize(
    ("files", "reason"),
    [
        (upload(content_type="application/zip"), "类型不在白名单里"),
        (upload(content_type="text/html"), "类型不在白名单里"),
        (upload(content=b""), "空文件"),
    ],
)
async def test_refused_uploads_never_reach_the_store(files: object, reason: str) -> None:
    store = MemoryObjectStore()
    async with client(build_test_app(store, granted=principal("assets:write"))) as http:
        response = await http.post(URL, files=files)  # type: ignore[arg-type]

    assert response.status_code == 422, reason
    assert store.objects == {}


async def test_oversized_files_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """超上限在读到那一刻就停手，不等整个文件进内存。"""

    monkeypatch.setattr(uploads_api, "MAX_UPLOAD_BYTES", 8)
    store = MemoryObjectStore()
    async with client(build_test_app(store, granted=principal("assets:write"))) as http:
        response = await http.post(URL, files=upload(content=b"x" * 64))

    assert response.status_code == 422
    assert store.objects == {}


async def test_storage_failure_is_reported_as_a_bad_gateway() -> None:
    """写不进去是存储那边的事，报 502 而不是 500：用户据此知道该重试。"""

    class BrokenStore:
        async def put_public_object(
            self, *, object_key: str, content: bytes, content_type: str
        ) -> str:
            raise ObjectStoreUnavailable("bucket 不可达")

    async with client(build_test_app(BrokenStore(), granted=principal("assets:write"))) as http:
        response = await http.post(URL, files=upload())

    assert response.status_code == 502
    assert "bucket 不可达" in response.json()["detail"]
