"""验证直传链路：签名带审计头、确认只按桶里的对象回答、角色门与没桶时不挂路由。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import build_app
from tests.helpers.generation import MemoryObjectStore
from tests.helpers.pg import IDENTITY_TABLES, truncate_clean
from tests.integration_no_llm.conftest import (
    make_client,
    make_runtime_config,
    register_and_login,
    set_roles_in_db,
)

OSS_ENVS = {
    "OSS_BUCKET": "iclip-test",
    "OSS_ENDPOINT": "oss-cn-hangzhou.aliyuncs.com",
    "OSS_ACCESS_KEY_ID": "ak",
    "OSS_ACCESS_KEY_SECRET": "sk",
    "OSS_PUBLIC_URL_BASE": "https://cdn.example.test",
}


@pytest.fixture
def bucket() -> MemoryObjectStore:
    return MemoryObjectStore()


@pytest.fixture
async def uploads_app(
    base_env: None,
    migrated_pg: str,
    monkeypatch: pytest.MonkeyPatch,
    bucket: MemoryObjectStore,
) -> AsyncGenerator[FastAPI]:
    """真实数据库配合 bucket 替身，隔离 OSS 凭证。"""

    for name, value in OSS_ENVS.items():
        monkeypatch.setenv(name, value)
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await truncate_clean(conn, IDENTITY_TABLES, cascade=True)
    try:
        yield build_app(make_runtime_config(), engine=engine, object_store=bucket)
    finally:
        await engine.dispose()


@pytest.fixture
async def client(uploads_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(uploads_app) as c:
        yield c


async def login_as_editor(client: httpx.AsyncClient, pg_url: str) -> str:
    user_id = await register_and_login(client)
    await set_roles_in_db(pg_url, "luke@example.com", ["editor"])
    return user_id


async def sign(client: httpx.AsyncClient, content_type: str) -> httpx.Response:
    return await client.post(
        "/uploads/sign", json={"contentType": content_type, "width": 1200, "height": 1600}
    )


async def test_upload_round_trip_hands_back_the_public_url(
    client: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    user_id = await login_as_editor(client, pg_url)

    signed = await sign(client, "video/mp4")
    assert signed.status_code == 200, signed.text
    ticket = signed.json()
    upload_id = ticket["uploadId"]
    assert ticket["upload"]["headers"] == {
        "Content-Type": "video/mp4",
        "x-oss-meta-uploader": user_id,
    }
    await bucket.put_public_object(
        object_key=f"iclip/agent/uploads/{upload_id}.mp4",
        content=b"MP4DATA" * 10,
        content_type="video/mp4",
    )

    confirmed = await client.post(f"/uploads/{upload_id}/confirm")

    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json() == {
        "url": f"https://cdn.example.test/iclip/agent/uploads/{upload_id}.mp4",
        "contentType": "video/mp4",
        "sizeBytes": 70,
    }
    again = await client.post(f"/uploads/{upload_id}/confirm")
    assert again.json() == confirmed.json()


async def test_confirming_something_nobody_uploaded_is_a_conflict(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)

    assert (await client.post(f"/uploads/{uuid.uuid4()}/confirm")).status_code == 409


async def test_viewer_cannot_sign(client: httpx.AsyncClient) -> None:
    """新账号默认是 viewer：能查爆款视频，不能上传。"""

    await register_and_login(client)

    assert (await sign(client, "image/jpeg")).status_code == 403
    me = (await client.get("/users/me")).json()["user"]
    assert "inspirations:read" in me["permissions"]
    assert "uploads:write" not in me["permissions"]


async def test_routes_are_absent_without_a_bucket(base_env: None, migrated_pg: str) -> None:
    engine = create_async_engine(migrated_pg)
    try:
        app = build_app(make_runtime_config(), engine=engine)
        async with make_client(app) as http:
            assert (
                await http.post("/uploads/sign", json={"contentType": "image/jpeg"})
            ).status_code == 404
            assert (await http.post(f"/uploads/{uuid.uuid4()}/confirm")).status_code == 404
    finally:
        await engine.dispose()
