"""资料库端点：持 ``generation:read`` 就能看全站，来源对话只交给对话属主与治理者。"""

from __future__ import annotations

import json
import uuid

import httpx
from sqlalchemy import text

from iclip.domains.generation.models import STATUS_COMPLETED
from iclip.domains.generation.schemas import KIND_VIDEO
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.pg import connected

VIDEOS = "/library/videos"
AUTHORS = "/library/authors"


async def login_as(client: httpx.AsyncClient, pg_url: str, username: str, role: str) -> uuid.UUID:
    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email)
    await set_roles_in_db(pg_url, email, [role])
    return uuid.UUID(user_id)


async def plant_video(pg_url: str, *, owner: uuid.UUID, user_name: str) -> uuid.UUID:
    """一段对话下一条成了的镜 1 出片；返回出片 id。"""

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
                " provider, request, status, metadata, output_url, created_at, updated_at)"
                " VALUES (:id, :owner, :conversation_id, :kind, 'test', CAST(:request AS jsonb),"
                " :status, '{\"shot\": 1}'::jsonb, 'https://oss.example.test/v.mp4', now(), now())"
            ),
            {
                "id": video_id,
                "owner": owner,
                "conversation_id": conversation_id,
                "kind": KIND_VIDEO,
                "request": json.dumps(
                    {"model": "m", "prompt": "模特走向镜头。", "user_name": user_name}
                ),
                "status": STATUS_COMPLETED,
            },
        )
    return video_id


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


async def test_others_see_the_video_but_not_the_conversation(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    owner = await login_as(client, pg_url, "nina", "editor")
    video_id = await plant_video(pg_url, owner=owner, user_name="nina")

    as_owner = (await client.get(f"{VIDEOS}/{video_id}")).json()
    await login_as(client, pg_url, "leo", "editor")
    as_colleague = (await client.get(f"{VIDEOS}/{video_id}")).json()
    listed = (await client.get(VIDEOS)).json()
    await login_as(client, pg_url, "boss", "root")
    as_governor = (await client.get(f"{VIDEOS}/{video_id}")).json()

    assert as_owner["video"]["conversationId"] is not None
    assert as_governor["video"]["conversationId"] == as_owner["video"]["conversationId"]
    assert as_colleague["video"]["conversationId"] is None
    assert as_colleague["video"]["take"]["prompt"] == "模特走向镜头。"
    assert [item["id"] for item in listed["items"]] == [str(video_id)]
    assert listed["items"][0]["conversationId"] is None and listed["total"] == 1


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
