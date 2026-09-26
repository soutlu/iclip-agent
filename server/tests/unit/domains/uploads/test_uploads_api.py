"""使用 bucket 与记录替身验证上传签名、审计头、权限、确认规则与记在谁名下。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI

from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION
from iclip.domains.uploads.api import create_uploads_router
from iclip.domains.uploads.models import (
    MAX_BYTES,
    MAX_LONG_EDGE_PIXELS,
    MIN_SHORT_EDGE_PIXELS,
    MediaKind,
)
from iclip.domains.uploads.service import API_KEY_HEADER, UPLOADER_HEADER, UploadService
from tests.helpers.app import app_with_principal
from tests.helpers.identity import InMemoryUserRepository
from tests.helpers.uploads import FakeBucket


def uploader(user_id: uuid.UUID | None = None, *, api_key_id: uuid.UUID | None = None) -> Principal:
    return Principal(
        kind="user" if api_key_id is None else "api_key",
        user_id=user_id or uuid.uuid4(),
        permissions=frozenset({"uploads:write"}),
        audit_label="tester",
        api_key_id=api_key_id,
        username="tester",
        key_name=None if api_key_id is None else "gateway",
    )


@dataclass
class RecordedUploads:
    """RecordUpload 替身：记下每次确认记给了谁、哪一次上传、什么种类、什么地址。"""

    calls: list[tuple[Principal, uuid.UUID, MediaKind, str]] = field(
        default_factory=list[tuple[Principal, uuid.UUID, MediaKind, str]]
    )

    async def __call__(
        self, principal: Principal, *, upload_id: uuid.UUID, kind: MediaKind, url: str
    ) -> None:
        self.calls.append((principal, upload_id, kind, url))


def build_test_app(
    bucket: FakeBucket, *, granted: Principal | None, recorded: RecordedUploads | None = None
) -> FastAPI:
    app = app_with_principal(granted)
    service = UploadService(bucket, record=recorded or RecordedUploads())
    app.include_router(create_uploads_router(service, act_as=ActAs(InMemoryUserRepository())))
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


async def confirm(
    http: httpx.AsyncClient, upload_id: str, *, user_name: str | None = None
) -> httpx.Response:
    if user_name is None:
        return await http.post(f"/uploads/{upload_id}/confirm")
    return await http.post(f"/uploads/{upload_id}/confirm", json={"userName": user_name})


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
    recorded = RecordedUploads()
    app = build_test_app(FakeBucket(), granted=uploader(), recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        assert (await confirm(http, upload_id)).status_code == 409
        assert (await confirm(http, str(uuid.uuid4()))).status_code == 409
    assert recorded.calls == [], "核对不过不记录"


async def test_oversized_upload_is_refused() -> None:
    """预签名 PUT 无法限制长度，确认时须校验桶内实际大小。"""

    bucket = FakeBucket()
    recorded = RecordedUploads()
    app = build_test_app(bucket, granted=uploader(), recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(
            f"iclip/agent/uploads/{upload_id}.jpg",
            content_type="image/jpeg",
            size_bytes=MAX_BYTES["image"] + 1,
        )
        response = await confirm(http, upload_id)

    assert response.status_code == 422
    assert recorded.calls == [], "核对不过不记录"


async def test_unexpected_type_in_the_bucket_is_refused() -> None:
    """Content-Type 签进了签名里，桶里仍可能出现别的类型（改过 CORS 或 SDK 直传），确认时按桶里的算。"""

    bucket = FakeBucket()
    recorded = RecordedUploads()
    app = build_test_app(bucket, granted=uploader(), recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.jpg", content_type="application/pdf")
        response = await confirm(http, upload_id)

    assert response.status_code == 422
    assert recorded.calls == [], "核对不过不记录"


# --- 确认即记录 -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("content_type", "ext", "kind"), [("image/png", "png", "image"), ("video/mp4", "mp4", "video")]
)
async def test_confirming_records_the_upload_by_its_id_kind_and_address(
    content_type: str, ext: str, kind: MediaKind
) -> None:
    """桶里核对过的才记：id 就是 uploadId，种类按桶里的类型定，地址就是交回的那个。"""

    bucket = FakeBucket()
    recorded = RecordedUploads()
    me = uploader()
    app = build_test_app(bucket, granted=me, recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http, content_type)).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.{ext}", content_type=content_type)
        response = await confirm(http, upload_id)

    assert response.status_code == 200, response.text
    assert recorded.calls == [(me, uuid.UUID(upload_id), kind, response.json()["url"])]


@pytest.mark.parametrize(
    ("caller", "name", "owner"),
    [
        ("browser", None, "self"),
        ("browser", "tester", "self"),
        ("key", None, "self"),
        ("key", "Shan.Hu", "self"),
        ("act_as_key", None, "self"),
        ("act_as_key", "Shan.Hu", "named"),
    ],
    ids=[
        "浏览器不给名字",
        "浏览器给自己的名字",
        "钥匙不给名字",
        "钥匙给了名字但不能替人办事",
        "替人办事的钥匙不给名字",
        "替人办事的钥匙给了名字",
    ],
)
async def test_the_upload_is_recorded_under_whoever_confirms_it(
    caller: str, name: str | None, owner: str
) -> None:
    """名字可选：给了才按替人办事换主体，不给就记在当前主体名下，钥匙不带名字也不报错；钥匙身份照记。"""

    bucket = FakeBucket()
    recorded = RecordedUploads()
    key_id = None if caller == "browser" else uuid.uuid4()
    me = uploader(api_key_id=key_id)
    if caller == "act_as_key":
        me = Principal(
            kind="api_key",
            user_id=me.user_id,
            permissions=frozenset({"uploads:write", ACT_AS_PERMISSION}),
            audit_label="luke#gateway",
            api_key_id=key_id,
            username="luke",
            key_name="gateway",
        )
    app = build_test_app(bucket, granted=me, recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.jpg", content_type="image/jpeg")
        response = await confirm(http, upload_id, user_name=name)

    assert response.status_code == 200, response.text
    ((recorded_as, _, _, _),) = recorded.calls
    assert recorded_as.api_key_id == key_id
    if owner == "self":
        assert recorded_as.user_id == me.user_id
    else:
        assert (recorded_as.user_id != me.user_id, recorded_as.username) == (True, "Shan.Hu")


async def test_a_browser_may_not_confirm_in_someone_elses_name() -> None:
    bucket = FakeBucket()
    recorded = RecordedUploads()
    app = build_test_app(bucket, granted=uploader(), recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.jpg", content_type="image/jpeg")
        response = await confirm(http, upload_id, user_name="Shan.Hu")

    assert response.status_code == 422
    assert recorded.calls == []
