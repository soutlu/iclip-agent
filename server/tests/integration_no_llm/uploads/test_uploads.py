"""验证直传链路：签名带审计头、确认只按桶里的对象回答并落一条上传记录（媒体生成没开也落）、
角色门与没桶时不挂路由。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import build_app
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationJob
from tests.helpers.app import make_client, make_runtime_config
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media
from tests.helpers.pg import connected, reset_database

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
        await reset_database(conn)
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
    assert await upload_rows(pg_url) == 0, "核对不过不落记录"


async def uploaded(
    client: httpx.AsyncClient, bucket: MemoryObjectStore, content_type: str, ext: str
) -> tuple[str, str]:
    """签一次、把字节放进桶；返回 uploadId 与对象 key。"""

    upload_id = (await sign(client, content_type)).json()["uploadId"]
    key = f"iclip/agent/uploads/{upload_id}.{ext}"
    await bucket.put_public_object(object_key=key, content=b"x" * 10, content_type=content_type)
    return upload_id, key


async def stored(pg_url: str, upload_id: str) -> GenerationJob:
    engine = create_async_engine(pg_url)
    try:
        return await SqlGenerationRepository(engine).get(uuid.UUID(upload_id), owner=None)
    finally:
        await engine.dispose()


async def upload_rows(pg_url: str) -> int:
    async with connected(pg_url) as conn:
        found = await conn.execute(
            text("SELECT count(*) FROM iclip.generation_jobs WHERE operation = 'upload'")
        )
        return int(found.scalar_one())


@pytest.mark.parametrize(
    ("content_type", "ext", "kind"), [("image/png", "png", "image"), ("video/mp4", "mp4", "video")]
)
async def test_confirming_records_an_upload_even_without_media_generation(
    client: httpx.AsyncClient,
    pg_url: str,
    bucket: MemoryObjectStore,
    content_type: str,
    ext: str,
    kind: str,
) -> None:
    """只开对象存储、没开媒体生成：确认照样落一条上传记录，id 就是 uploadId，创建即完成、
    没有请求与来源、不挂对话，产物地址就是交回的 url，属主是确认的人。"""

    user_id = await login_as_editor(client, pg_url)
    upload_id, _ = await uploaded(client, bucket, content_type, ext)

    confirmed = await client.post(f"/uploads/{upload_id}/confirm")

    assert confirmed.status_code == 200, confirmed.text
    job = await stored(pg_url, upload_id)
    assert (
        job.kind,
        job.operation,
        job.status,
        job.output_url,
        job.request,
        job.source_job_id,
        job.source_url,
        job.conversation_id,
        job.task_id,
        job.owner_user_id,
        job.api_key_id,
    ) == (
        kind,
        "upload",
        "completed",
        confirmed.json()["url"],
        None,
        None,
        None,
        None,
        None,
        uuid.UUID(user_id),
        None,
    )
    assert job.finished_at is not None


async def test_confirming_again_keeps_the_one_record_and_its_first_owner(
    uploads_app: FastAPI, pg_url: str, bucket: MemoryObjectStore
) -> None:
    """替人办事的钥匙按名字记到那个人名下；再确认一次换了名字也还是那一条、属主不变；桶里的对象
    没了，确认照旧按桶回答 409。"""

    async with make_client(uploads_app) as root:
        await register_and_login(root)
        await set_roles_in_db(pg_url, "luke@example.com", ["root"])
        created = await root.post(
            "/api-keys",
            json={"name": "multiflow", "permissions": ["uploads:write", "users:act_as"]},
        )
        assert created.status_code == 201, created.text
        issued = created.json()["apiKey"]
        async with make_client(uploads_app) as gateway:
            gateway.headers["Authorization"] = f"Bearer {issued['token']}"
            upload_id, key = await uploaded(gateway, bucket, "image/png", "png")
            first = await gateway.post(
                f"/uploads/{upload_id}/confirm", json={"userName": "Shan.Hu"}
            )
            again = await gateway.post(
                f"/uploads/{upload_id}/confirm", json={"userName": "Edna.Li"}
            )
            del bucket.objects[key]
            gone = await gateway.post(f"/uploads/{upload_id}/confirm")
        users = (await root.get("/users")).json()["items"]

    assert first.status_code == 200, first.text
    assert again.json() == first.json()
    assert gone.status_code == 409
    assert await upload_rows(pg_url) == 1
    job = await stored(pg_url, upload_id)
    shan = next(user["id"] for user in users if user["username"] == "Shan.Hu")
    assert (str(job.owner_user_id), str(job.api_key_id)) == (shan, issued["id"])


@pytest.fixture
async def media_app(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch, bucket: MemoryObjectStore
) -> AsyncGenerator[FastAPI]:
    """开了媒体生成的 app：队列连接器用替身，生成记录的接口挂得上。"""

    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await reset_database(conn)
    try:
        yield build_app(
            config_with_media(),
            engine=engine,
            object_store=bucket,
            queue_connector=InMemoryConnector(),
        )
    finally:
        await engine.dispose()


async def test_an_upload_reads_back_through_the_generation_records(
    media_app: FastAPI, pg_url: str, bucket: MemoryObjectStore
) -> None:
    """GET /generations/{uploadId} 读得到那条上传；按属主列会看到它，按 operation=generate 筛掉。"""

    async with make_client(media_app) as http:
        await login_as_editor(http, pg_url)
        upload_id, _ = await uploaded(http, bucket, "image/png", "png")
        confirmed = (await http.post(f"/uploads/{upload_id}/confirm")).json()
        record = await http.get(f"/generations/{upload_id}")
        listed = await http.get("/generations")
        generated = await http.get("/generations", params={"operation": "generate"})

    assert record.status_code == 200, record.text
    generation = record.json()["generation"]
    assert (
        generation["kind"],
        generation["operation"],
        generation["status"],
        generation["outputUrl"],
        generation["request"],
        generation["sourceUrl"],
    ) == ("image", "upload", "completed", confirmed["url"], None, None)
    assert generation["finishedAt"] is not None
    assert [item["id"] for item in listed.json()["items"]] == [upload_id]
    assert generated.json()["items"] == []


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
