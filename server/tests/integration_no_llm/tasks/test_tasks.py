"""验证需求单的数据库时钟、表约束、条件更新原子性和持久化往返。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from tests.helpers.tasks import STYLE_NO
from tests.integration_no_llm.conftest import (
    make_client,
    register_and_login,
    set_roles_in_db,
)

URL = "/tasks"

BRIEF = {
    "theme": "秋冬新品",
    "purpose": "种草",
    "requirementDescription": "三十秒的上身效果",
    "durationSeconds": 30,
    "ratio": "9:16",
    "referenceImages": ["https://example.com/a.jpg"],
}


def future(days: int = 7) -> str:
    return (datetime.now(UTC) + timedelta(days=days)).isoformat()


async def login_as_editor(client: httpx.AsyncClient, pg_url: str, *, username: str = "luke") -> str:
    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email)
    await set_roles_in_db(pg_url, email, ["editor"])
    return user_id


async def create(client: httpx.AsyncClient, **body: object) -> httpx.Response:
    return await client.post(
        URL,
        json={
            "title": "秋冬新品短视频",
            "styleNo": STYLE_NO,
            "brief": BRIEF,
            "deadline": future(),
            **body,
        },
    )


async def set_status_directly(pg_url: str, task_id: str, status: str) -> None:
    """绕过 API 更新状态，模拟读取后的并发修改。"""

    engine = create_async_engine(pg_url)
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text("UPDATE iclip.tasks SET status = :status WHERE id = CAST(:id AS uuid)"),
                {"status": status, "id": task_id},
            )
    finally:
        await engine.dispose()


async def test_full_lifecycle_over_http(client: httpx.AsyncClient, pg_url: str) -> None:

    user_id = await login_as_editor(client, pg_url)

    created = await create(client)
    assert created.status_code == 201, created.text
    task = created.json()["task"]
    assert task["status"] == "draft"
    assert task["assigneeUserIds"] == []

    published = await client.post(f"{URL}/{task['id']}/publish")
    assert published.status_code == 200, published.text
    assert published.json()["task"]["status"] == "published"

    confirmed = await client.post(f"{URL}/{task['id']}/confirm")
    assert confirmed.json()["task"]["status"] == "confirmed"
    assert confirmed.json()["task"]["assigneeUserIds"] == [user_id]

    withdrawn = await client.post(f"{URL}/{task['id']}/withdraw")
    assert withdrawn.json()["task"]["status"] == "withdrawn"
    assert withdrawn.json()["task"]["assigneeUserIds"] == [user_id]

    assert (await client.post(f"{URL}/{task['id']}/withdraw")).status_code == 409


async def test_brief_survives_the_round_trip(client: httpx.AsyncClient, pg_url: str) -> None:

    await login_as_editor(client, pg_url)
    task = (await create(client)).json()["task"]

    read_back = (await client.get(f"{URL}/{task['id']}")).json()["task"]["brief"]

    assert {key: read_back[key] for key in BRIEF} == BRIEF
    assert read_back["audience"] == ""
    assert read_back["referenceVideos"] == []


async def test_style_snapshot_survives_the_round_trip(
    client: httpx.AsyncClient, pg_url: str
) -> None:

    await login_as_editor(client, pg_url)
    created = (await create(client)).json()["task"]

    read_back = (await client.get(f"{URL}/{created['id']}")).json()["task"]

    assert read_back["style"] == created["style"]
    assert read_back["style"]["styleNo"] == STYLE_NO
    assert read_back["brief"]["styleNos"] == [STYLE_NO]

    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            stored = (
                await conn.execute(
                    text("SELECT style FROM iclip.tasks WHERE id = CAST(:id AS uuid)"),
                    {"id": created["id"]},
                )
            ).scalar_one()
    finally:
        await engine.dispose()
    assert stored == created["style"]


async def test_timestamps_come_from_the_database_clock(
    client: httpx.AsyncClient, pg_url: str
) -> None:

    await login_as_editor(client, pg_url)
    task = (await create(client)).json()["task"]

    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            drift = (
                await conn.execute(
                    text(
                        "SELECT extract(epoch FROM (now() - created_at)) FROM iclip.tasks"
                        " WHERE id = CAST(:id AS uuid)"
                    ),
                    {"id": task["id"]},
                )
            ).scalar_one()
    finally:
        await engine.dispose()

    assert 0 <= float(drift) < 60


async def test_a_deadline_in_the_past_cannot_be_published(
    client: httpx.AsyncClient, pg_url: str
) -> None:

    await login_as_editor(client, pg_url)
    task = (await create(client, deadline=future(-1))).json()["task"]

    refused = await client.post(f"{URL}/{task['id']}/publish")

    assert refused.status_code == 409, refused.text
    assert (await client.get(f"{URL}/{task['id']}")).json()["task"]["status"] == "draft"


async def test_status_guard_stops_a_write_built_on_stale_reading(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """读取与写入间存在 await；WHERE 状态守卫须原子地拒绝基于过时状态的写入。"""

    await login_as_editor(client, pg_url)
    task = (await create(client)).json()["task"]
    await client.post(f"{URL}/{task['id']}/publish")
    await set_status_directly(pg_url, task["id"], "withdrawn")

    stale = await client.post(f"{URL}/{task['id']}/confirm")

    assert stale.status_code == 409
    assert (await client.get(f"{URL}/{task['id']}")).json()["task"]["status"] == "withdrawn"


@pytest.mark.parametrize(
    ("status", "deadline", "brief", "style", "constraint"),
    [
        ("nonsense", "now()", "'{}'::jsonb", "'{}'::jsonb", "tasks_status_check"),
        ("published", "NULL", "'{}'::jsonb", "'{}'::jsonb", "tasks_deadline_check"),
        ("draft", "now()", "'[]'::jsonb", "'{}'::jsonb", "tasks_brief_object_check"),
        ("draft", "now()", "'{}'::jsonb", "'[]'::jsonb", "tasks_style_object_check"),
    ],
)
async def test_constraints_live_on_the_table(
    client: httpx.AsyncClient,
    pg_url: str,
    status: str,
    deadline: str,
    brief: str,
    style: str,
    constraint: str,
) -> None:

    user_id = await login_as_editor(client, pg_url)
    statement = text(
        "INSERT INTO iclip.tasks"
        " (id, title, status, priority, deadline, creator_user_id, style, brief,"
        " created_at, updated_at)"
        f" VALUES (gen_random_uuid(), 't', :status, 0, {deadline}, CAST(:owner AS uuid),"
        f" {style}, {brief}, now(), now())"
    )
    engine = create_async_engine(pg_url)
    try:
        with pytest.raises(DBAPIError) as raised:
            async with engine.begin() as conn:
                await conn.execute(statement, {"status": status, "owner": user_id})
    finally:
        await engine.dispose()
    assert constraint in str(raised.value)


async def test_a_task_outlives_nothing_silently(client: httpx.AsyncClient, pg_url: str) -> None:
    """需求单创建者外键使用 RESTRICT，避免删除账号破坏业务记录。"""

    user_id = await login_as_editor(client, pg_url)
    await create(client)

    engine = create_async_engine(pg_url)
    try:
        with pytest.raises(DBAPIError) as raised:
            async with engine.begin() as conn:
                await conn.execute(
                    text("DELETE FROM iclip.users WHERE id = CAST(:id AS uuid)"), {"id": user_id}
                )
    finally:
        await engine.dispose()
    assert "tasks" in str(raised.value)


async def test_viewer_reads_everyones_tasks_but_writes_none(
    app: object, client: httpx.AsyncClient, pg_url: str
) -> None:

    await login_as_editor(client, pg_url, username="luke")
    task = (await create(client)).json()["task"]

    from fastapi import FastAPI

    assert isinstance(app, FastAPI)
    async with make_client(app) as other:
        await register_and_login(other, username="viewer", email="viewer@example.com")
        listed = await other.get(URL)
        blocked = await other.post(URL, json={"title": "我也提一个", "styleNo": STYLE_NO})
        forbidden = await other.delete(f"{URL}/{task['id']}")

    assert [item["id"] for item in listed.json()["items"]] == [task["id"]]
    assert blocked.status_code == 403
    assert forbidden.status_code == 403


async def test_second_claim_adds_a_person_without_touching_the_task_row(
    app: object, client: httpx.AsyncClient, pg_url: str
) -> None:
    """联合主键防止重复认领；已 confirmed 时只新增认领记录，不更新需求单时间。"""

    first_id = await login_as_editor(client, pg_url, username="luke")
    task = (await create(client)).json()["task"]
    await client.post(f"{URL}/{task['id']}/publish")
    confirmed = (await client.post(f"{URL}/{task['id']}/confirm")).json()["task"]
    assert confirmed["assigneeUserIds"] == [first_id]

    again = (await client.post(f"{URL}/{task['id']}/confirm")).json()["task"]
    assert again["assigneeUserIds"] == [first_id]

    from fastapi import FastAPI

    assert isinstance(app, FastAPI)
    async with make_client(app) as other:
        second_id = await register_and_login(other, username="mia", email="mia@example.com")
        await set_roles_in_db(pg_url, "mia@example.com", ["editor"])
        joined = (await other.post(f"{URL}/{task['id']}/confirm")).json()["task"]

    assert joined["assigneeUserIds"] == [first_id, second_id]
    assert joined["updatedAt"] == confirmed["updatedAt"]
