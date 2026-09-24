"""埋点端点：持 ``generation:read`` 就能记下载，发起人与时刻由服务端盖；不可下载的一律同一个 404。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from datetime import timedelta

import httpx
from sqlalchemy import text
from sqlalchemy.engine import RowMapping

from iclip.domains.generation.models import STATUS_COMPLETED, STATUS_FAILED
from iclip.domains.generation.schemas import CLIP_REFERENCE, KIND_CLIP, KIND_IMAGE, KIND_VIDEO
from iclip.domains.tracking.models import VIDEO_DOWNLOADED
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.pg import connected

EVENTS = "/tracking/events"
MASTER = "master"
"""ClipPurpose 的成片取值；生成域没有单独的常量。"""

# 标签、种类、状态、clip 用途、原作（标签）、有没有地址。原作要先插。
_JOBS: tuple[tuple[str, str, str, str | None, str | None, bool], ...] = (
    ("video", KIND_VIDEO, STATUS_COMPLETED, None, None, True),
    ("master", KIND_CLIP, STATUS_COMPLETED, MASTER, "video", True),
    ("reference", KIND_CLIP, STATUS_COMPLETED, CLIP_REFERENCE, "video", True),
    ("edited", KIND_VIDEO, STATUS_COMPLETED, None, "video", True),
    ("failed", KIND_VIDEO, STATUS_FAILED, None, None, False),
    ("no_url", KIND_VIDEO, STATUS_COMPLETED, None, None, False),
    ("image", KIND_IMAGE, STATUS_COMPLETED, None, None, True),
)
DOWNLOADABLE = ("video", "master")


async def login_as(client: httpx.AsyncClient, pg_url: str, username: str, role: str) -> uuid.UUID:
    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email)
    await set_roles_in_db(pg_url, email, [role])
    return uuid.UUID(user_id)


async def plant_jobs(pg_url: str, *, owner: uuid.UUID) -> dict[str, uuid.UUID]:
    """一段对话里一条成了的出片连同名下的成片、参考片段与编辑结果，外加没成的、没地址的出片与一张图。"""

    conversation_id = uuid.uuid4()
    ids = {label: uuid.uuid4() for label, *_ in _JOBS}
    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, created_at,"
                " updated_at) VALUES (:id, :owner, 'storyboard', '凉鞋合集', now(), now())"
            ),
            {"id": conversation_id, "owner": owner},
        )
        for label, kind, status, purpose, root, has_url in _JOBS:
            request = (
                {"purpose": purpose, "segments": []}
                if purpose is not None
                else {"model": "m", "prompt": "p", "user_name": "nina"}
            )
            await conn.execute(
                text(
                    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                    " provider, request, status, root_job_id, output_url, created_at, updated_at)"
                    " VALUES (:id, :owner, :conversation_id, :kind, 'test', CAST(:request AS jsonb),"
                    " :status, :root, :output_url, now(), now())"
                ),
                {
                    "id": ids[label],
                    "owner": owner,
                    "conversation_id": conversation_id,
                    "kind": kind,
                    "request": json.dumps(request),
                    "status": status,
                    "root": None if root is None else ids[root],
                    "output_url": f"https://oss.example.test/{label}.mp4" if has_url else None,
                },
            )
    return ids


async def recorded(pg_url: str) -> Sequence[RowMapping]:
    async with connected(pg_url) as conn:
        return (
            (
                await conn.execute(
                    text(
                        "SELECT name, job_id, conversation_id, user_id, api_key_id,"
                        " now() - occurred_at AS age FROM iclip.tracking_events"
                    )
                )
            )
            .mappings()
            .all()
        )


def download(job_id: uuid.UUID) -> dict[str, str]:
    return {"name": VIDEO_DOWNLOADED, "jobId": str(job_id)}


async def test_anonymous_is_401(client: httpx.AsyncClient) -> None:
    assert (await client.post(EVENTS, json=download(uuid.uuid4()))).status_code == 401


async def test_anyone_who_reads_generations_records_a_download_of_any_video_or_master(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """片不必是自己的：资料库里全站的片谁都能下。发起人取自登录态，时刻是数据库此刻。"""

    owner = await login_as(client, pg_url, "nina", "editor")
    jobs = await plant_jobs(pg_url, owner=owner)
    viewer = await login_as(client, pg_url, "leo", "viewer")

    responses = [await client.post(EVENTS, json=download(jobs[label])) for label in DOWNLOADABLE]

    assert [(r.status_code, r.content) for r in responses] == [(204, b""), (204, b"")]
    rows = await recorded(pg_url)
    assert {
        (row["name"], row["job_id"], row["conversation_id"], row["user_id"], row["api_key_id"])
        for row in rows
    } == {(VIDEO_DOWNLOADED, jobs[label], None, viewer, None) for label in DOWNLOADABLE}
    assert all(timedelta(0) <= row["age"] < timedelta(minutes=1) for row in rows)


async def test_anything_but_a_downloadable_video_is_the_same_404(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """参考片段、编辑结果、没成的、没地址的、图片与根本不存在的，状态码与报错一字不差。"""

    owner = await login_as(client, pg_url, "nina", "editor")
    jobs = await plant_jobs(pg_url, owner=owner)
    refused = [jobs[label] for label, *_ in _JOBS if label not in DOWNLOADABLE]

    responses = [
        await client.post(EVENTS, json=download(job_id)) for job_id in (*refused, uuid.uuid4())
    ]

    assert [r.status_code for r in responses] == [404] * len(responses)
    assert len({r.json()["detail"] for r in responses}) == 1
    assert await recorded(pg_url) == []


async def test_the_body_names_a_known_event_and_exactly_its_subject(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """事件名封闭；下载只带 ``jobId``；发起人与时刻不由客户端给。"""

    owner = await login_as(client, pg_url, "nina", "editor")
    video = (await plant_jobs(pg_url, owner=owner))["video"]
    conversation = str(uuid.uuid4())

    bodies = (
        {"name": "video.played", "jobId": str(video)},
        {"name": VIDEO_DOWNLOADED},
        {"name": VIDEO_DOWNLOADED, "conversationId": conversation},
        {**download(video), "conversationId": conversation},
        {**download(video), "userId": str(uuid.uuid4())},
        {**download(video), "occurredAt": "2026-09-01T00:00:00Z"},
    )
    responses = [await client.post(EVENTS, json=body) for body in bodies]

    assert [r.status_code for r in responses] == [422] * len(bodies)
    assert await recorded(pg_url) == []
