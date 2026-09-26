"""资料库端点：持 ``generation:read`` 就能看全站连同来源对话，打不打得开对话按对话自己的可读范围。"""

from __future__ import annotations

import json
import uuid

import httpx
from sqlalchemy import text

from iclip.domains.generation.models import STATUS_COMPLETED
from iclip.domains.generation.schemas import KIND_VIDEO, OPERATION_GENERATE
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.pg import connected

VIDEOS = "/library/videos"
AUTHORS = "/library/authors"
PASSWORD = "password-123"


async def login_as(client: httpx.AsyncClient, pg_url: str, username: str, role: str) -> uuid.UUID:
    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email, password=PASSWORD)
    await set_roles_in_db(pg_url, email, [role])
    return uuid.UUID(user_id)


async def login_again(client: httpx.AsyncClient, username: str) -> None:
    logged_in = await client.post("/auth/login", data={"username": username, "password": PASSWORD})
    assert logged_in.status_code == 204, logged_in.text


async def plant_video(
    pg_url: str, *, owner: uuid.UUID, user_name: str
) -> tuple[uuid.UUID, uuid.UUID]:
    """一段对话下一条成了的镜 1 出片；返回（对话 id，出片 id）。"""

    conversation_id, video_id = uuid.uuid4(), uuid.uuid4()
    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, created_at,"
                " updated_at) VALUES (:id, :owner, 'storyboard', '凉鞋合集', now(), now())"
            ),
            {"id": conversation_id, "owner": owner},
        )
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                " operation, provider, request, status, shot_index, output_url, created_at,"
                " updated_at, finished_at)"
                " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'test',"
                " CAST(:request AS jsonb), :status, 1, 'https://oss.example.test/v.mp4', now(),"
                " now(), now())"
            ),
            {
                "id": video_id,
                "owner": owner,
                "conversation_id": conversation_id,
                "kind": KIND_VIDEO,
                "operation": OPERATION_GENERATE,
                "request": json.dumps(
                    {"model": "m", "prompt": "模特走向镜头。", "user_name": user_name}
                ),
                "status": STATUS_COMPLETED,
            },
        )
    return conversation_id, video_id


async def mark_deleted(pg_url: str, conversation_id: uuid.UUID) -> None:
    async with connected(pg_url) as conn:
        await conn.execute(
            text("UPDATE iclip.conversations SET deleted_at = now() WHERE id = :id"),
            {"id": conversation_id},
        )


async def test_anonymous_is_401(client: httpx.AsyncClient) -> None:
    for path in (VIDEOS, f"{VIDEOS}/{uuid.uuid4()}", AUTHORS):
        assert (await client.get(path)).status_code == 401


async def test_viewer_reads_the_empty_library(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as(client, pg_url, "viewer", "viewer")

    videos = await client.get(VIDEOS)
    authors = await client.get(AUTHORS)
    missing = await client.get(f"{VIDEOS}/{uuid.uuid4()}")

    assert videos.status_code == 200, videos.text
    assert videos.json() == {"items": [], "nextCursor": None, "total": 0}
    assert authors.json() == {"items": []}
    assert missing.status_code == 404


async def test_everyone_gets_the_conversation_only_readers_can_open_it(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """卡 id 就是对话 id，人人拿得到对话；打不打得开按对话的可读范围，删了只剩治理者打得开。
    作者按属主，不看请求里的名字。"""

    owner = await login_as(client, pg_url, "nina", "editor")
    conversation_id, video_id = await plant_video(pg_url, owner=owner, user_name="someone-else")
    card = f"{VIDEOS}/{conversation_id}"

    as_owner = await client.get(card)
    await login_as(client, pg_url, "leo", "editor")
    as_colleague = await client.get(card)
    listed = (await client.get(VIDEOS)).json()
    await login_as(client, pg_url, "boss", "root")
    as_governor = await client.get(card)
    by_take = await client.get(f"{VIDEOS}/{video_id}")
    await mark_deleted(pg_url, conversation_id)
    governor_after_delete = await client.get(card)
    await login_again(client, "nina")
    owner_after_delete = await client.get(card)

    assert as_owner.status_code == 200, as_owner.text
    detail = as_owner.json()
    video = detail["video"]
    assert video["id"] == video["conversationId"] == str(conversation_id)
    assert video["canOpenConversation"] is True and video["userName"] == "nina"
    assert [
        (group["shotIndex"], [(v["kind"], v["jobId"], v["userName"]) for v in group["versions"]])
        for group in detail["groups"]
    ] == [(1, [("take", str(video_id), "nina")])]

    colleague = as_colleague.json()["video"]
    assert colleague["conversationId"] == str(conversation_id)
    assert colleague["canOpenConversation"] is False
    assert colleague["take"]["prompt"] == "模特走向镜头。"
    assert [(item["id"], item["canOpenConversation"]) for item in listed["items"]] == [
        (str(conversation_id), False)
    ]
    assert listed["total"] == 1

    assert as_governor.json()["video"]["canOpenConversation"] is True
    assert by_take.status_code == 404
    assert governor_after_delete.json()["video"]["canOpenConversation"] is True
    assert owner_after_delete.status_code == 200
    assert owner_after_delete.json()["video"]["canOpenConversation"] is False


async def test_bad_parameters_are_422(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as(client, pg_url, "viewer", "viewer")

    inverted = await client.get(
        VIDEOS, params={"since": "2026-09-02T00:00:00Z", "until": "2026-09-01T00:00:00Z"}
    )
    bad_cursor = await client.get(VIDEOS, params={"cursor": "not-a-cursor"})
    bad_orientation = await client.get(VIDEOS, params={"orientation": "square"})

    assert inverted.status_code == 422 and "since" in inverted.json()["detail"]
    assert bad_cursor.status_code == 422 and "cursor" in bad_cursor.json()["detail"]
    assert bad_orientation.status_code == 422
