"""验证素材的数据库时间、唯一及 CHECK 约束、创建者外键和直传登记链路。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import build_app
from tests.helpers.generation import MemoryObjectStore
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
async def assets_app(
    base_env: None,
    migrated_pg: str,
    monkeypatch: pytest.MonkeyPatch,
    bucket: MemoryObjectStore,
) -> AsyncGenerator[FastAPI]:
    """真实数据库配合 bucket 替身，隔离 OSS 凭证并验证素材记录。"""

    for name, value in OSS_ENVS.items():
        monkeypatch.setenv(name, value)
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE iclip.media_assets, iclip.api_keys, iclip.users CASCADE"))
    try:
        yield build_app(make_runtime_config(), engine=engine, object_store=bucket)
    finally:
        await engine.dispose()


@pytest.fixture
async def client(assets_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(assets_app) as c:
        yield c


async def login_as_editor(client: httpx.AsyncClient, pg_url: str, *, username: str = "luke") -> str:
    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email)
    await set_roles_in_db(pg_url, email, ["editor"])
    return user_id


async def upload(
    client: httpx.AsyncClient,
    bucket: MemoryObjectStore,
    *,
    content_type: str = "image/jpeg",
    content: bytes = b"JPEGDATA",
) -> httpx.Response:

    signed = await client.post(
        "/uploads/sign", json={"contentType": content_type, "width": 1200, "height": 1600}
    )
    assert signed.status_code == 200, signed.text
    asset_id = signed.json()["assetId"]
    ext = {"image/jpeg": "jpg", "video/mp4": "mp4"}[content_type]
    await bucket.put_public_object(
        object_key=f"iclip/agent/uploads/{asset_id}.{ext}",
        content=content,
        content_type=content_type,
    )
    return await client.post(f"/assets/{asset_id}")


async def test_upload_round_trip_lands_a_row(
    client: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:

    user_id = await login_as_editor(client, pg_url)

    registered = await upload(client, bucket, content_type="video/mp4", content=b"MP4DATA" * 10)
    assert registered.status_code == 201, registered.text
    asset = registered.json()["asset"]

    fetched = (await client.get(f"/assets/{asset['id']}")).json()["asset"]
    assert fetched == asset
    assert fetched["assetType"] == "video"
    assert fetched["sizeBytes"] == len(b"MP4DATA" * 10)
    assert fetched["creatorUserId"] == user_id
    assert fetched["url"] == f"https://cdn.example.test/iclip/agent/uploads/{asset['id']}.mp4"


async def test_created_at_comes_from_the_database_clock(
    client: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    """登记时间须使用数据库时钟，避免多应用实例时钟差异改变列表顺序。"""

    await login_as_editor(client, pg_url)
    asset_id = (await upload(client, bucket)).json()["asset"]["id"]

    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            row = (
                await conn.execute(
                    text(
                        "SELECT created_at, now() - created_at AS drift FROM iclip.media_assets "
                        "WHERE id = CAST(:id AS uuid)"
                    ),
                    {"id": asset_id},
                )
            ).one()
    finally:
        await engine.dispose()

    assert row.created_at is not None
    assert abs(row.drift.total_seconds()) < 5, "写的是数据库自己的 now()"


async def test_one_object_can_only_be_registered_once(
    client: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:

    await login_as_editor(client, pg_url)
    asset_id = (await upload(client, bucket)).json()["asset"]["id"]

    engine = create_async_engine(pg_url)
    try:
        async with engine.begin() as conn:
            user_id = (await conn.execute(text("SELECT id FROM iclip.users LIMIT 1"))).scalar_one()
            with pytest.raises(IntegrityError):
                await conn.execute(
                    text(
                        "INSERT INTO iclip.media_assets "
                        "(id, creator_user_id, asset_type, object_key, content_type, "
                        " size_bytes, created_at) "
                        "VALUES (gen_random_uuid(), :user_id, 'image', :key, 'image/jpeg', 1, now())"
                    ),
                    {"user_id": user_id, "key": f"iclip/agent/uploads/{asset_id}.jpg"},
                )
    finally:
        await engine.dispose()


async def test_creator_is_protected_from_silent_deletion(
    client: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    """素材为共享业务记录，创建者删除应由 RESTRICT 外键阻止。"""

    await login_as_editor(client, pg_url)
    await upload(client, bucket)

    engine = create_async_engine(pg_url)
    try:
        async with engine.begin() as conn:
            with pytest.raises(IntegrityError):
                await conn.execute(text("DELETE FROM iclip.users"))
    finally:
        await engine.dispose()


async def test_everyone_sees_everyones_assets(
    client: httpx.AsyncClient, assets_app: FastAPI, pg_url: str, bucket: MemoryObjectStore
) -> None:

    luke = await login_as_editor(client, pg_url)
    mine = (await upload(client, bucket)).json()["asset"]["id"]

    async with make_client(assets_app) as other:
        await login_as_editor(other, pg_url, username="mia")
        theirs = (await upload(other, bucket, content_type="video/mp4")).json()["asset"]["id"]

        listed = (await other.get("/assets")).json()["items"]
        assert {item["id"] for item in listed} == {mine, theirs}

        filtered = (await other.get("/assets", params={"creatorUserId": luke})).json()["items"]
        assert [item["id"] for item in filtered] == [mine]


async def test_registering_something_nobody_uploaded_is_a_conflict(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)

    response = await client.post(f"/assets/{uuid.uuid4()}")

    assert response.status_code == 409


async def test_routes_are_absent_without_a_bucket(base_env: None, migrated_pg: str) -> None:

    engine = create_async_engine(migrated_pg)
    try:
        app = build_app(make_runtime_config(), engine=engine)
        async with make_client(app) as http:
            assert (
                await http.post("/uploads/sign", json={"contentType": "image/jpeg"})
            ).status_code == 404
            assert (await http.get("/assets")).status_code == 404
    finally:
        await engine.dispose()
