"""T-TASK-02：需求单在真库上的事实——数据库的钟、写在表上的约束、状态守卫的原子性。

这一层只验内存替身验不了的东西：期限比较用的是哪只钟、CHECK 是不是真的在表上、
「读到写之间被人插了一手」会不会被守住、brief 存进去读回来是不是同一份。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

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
        URL, json={"title": "秋冬新品短视频", "brief": BRIEF, "deadline": future(), **body}
    )


async def set_status_directly(pg_url: str, task_id: str, status: str) -> None:
    """绕开 API 改状态，模拟「另一个人抢在你前面动了这一行」。"""

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
    """建 → 发 → 确认 → 撤回，走完整条 HTTP 路径。"""

    await login_as_editor(client, pg_url)

    created = await create(client)
    assert created.status_code == 201, created.text
    task = created.json()["task"]
    assert task["status"] == "draft"

    published = await client.post(f"{URL}/{task['id']}/publish")
    assert published.status_code == 200, published.text
    assert published.json()["task"]["status"] == "published"

    confirmed = await client.post(f"{URL}/{task['id']}/confirm")
    assert confirmed.json()["task"]["status"] == "confirmed"

    withdrawn = await client.post(f"{URL}/{task['id']}/withdraw")
    assert withdrawn.json()["task"]["status"] == "withdrawn"

    # 撤回是终态：再撤一次、或想改回去，都是 409。
    assert (await client.post(f"{URL}/{task['id']}/withdraw")).status_code == 409


async def test_brief_survives_the_round_trip(client: httpx.AsyncClient, pg_url: str) -> None:
    """brief 存进去读回来是同一份：入库 camelCase，读回来重新校验一次。"""

    await login_as_editor(client, pg_url)
    task = (await create(client)).json()["task"]

    read_back = (await client.get(f"{URL}/{task['id']}")).json()["task"]["brief"]

    assert {key: read_back[key] for key in BRIEF} == BRIEF
    # 没填的字段有确定的空值，不是缺字段。
    assert read_back["audience"] == ""
    assert read_back["referenceVideos"] == []


async def test_timestamps_come_from_the_database_clock(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """时刻由库写。应用进程的钟快了几秒，「谁先动的」就会排错。"""

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
    """「期限还没到」这句比较发生在数据库里——这条用例是那只钟的落点。"""

    await login_as_editor(client, pg_url)
    task = (await create(client, deadline=future(-1))).json()["task"]

    refused = await client.post(f"{URL}/{task['id']}/publish")

    assert refused.status_code == 409, refused.text
    assert (await client.get(f"{URL}/{task['id']}")).json()["task"]["status"] == "draft"


async def test_status_guard_stops_a_write_built_on_stale_reading(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """判断和写入之间隔着一次 await；那当口这一行被撤回了，这次改动必须落空。

    守卫写在 ``WHERE`` 里，所以它是原子的——内存替身模拟不出这一点。
    """

    await login_as_editor(client, pg_url)
    task = (await create(client)).json()["task"]
    await client.post(f"{URL}/{task['id']}/publish")
    await set_status_directly(pg_url, task["id"], "withdrawn")

    stale = await client.post(f"{URL}/{task['id']}/confirm")

    assert stale.status_code == 409
    assert (await client.get(f"{URL}/{task['id']}")).json()["task"]["status"] == "withdrawn"


@pytest.mark.parametrize(
    ("status", "deadline", "brief", "constraint"),
    [
        ("nonsense", "now()", "'{}'::jsonb", "tasks_status_check"),
        ("published", "NULL", "'{}'::jsonb", "tasks_deadline_check"),
        ("draft", "now()", "'[]'::jsonb", "tasks_brief_object_check"),
    ],
)
async def test_constraints_live_on_the_table(
    client: httpx.AsyncClient,
    pg_url: str,
    status: str,
    deadline: str,
    brief: str,
    constraint: str,
) -> None:
    """三条规则写在表上，不只写在 Python 里：破了就是数据本身错了。"""

    user_id = await login_as_editor(client, pg_url)
    statement = text(
        "INSERT INTO iclip.tasks"
        " (id, title, status, priority, deadline, creator_user_id, brief, created_at, updated_at)"
        f" VALUES (gen_random_uuid(), 't', :status, 0, {deadline}, CAST(:owner AS uuid),"
        f" {brief}, now(), now())"
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
    """提需求的人不能被静默删掉：需求单是公司账本上的事实，外键用 restrict 挡住。"""

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
    """需求单是全公司的工作队列：别人提的看得见，但 viewer 改不动。"""

    await login_as_editor(client, pg_url, username="luke")
    task = (await create(client)).json()["task"]

    from fastapi import FastAPI

    assert isinstance(app, FastAPI)
    async with make_client(app) as other:
        await register_and_login(other, username="viewer", email="viewer@example.com")
        listed = await other.get(URL)
        blocked = await other.post(URL, json={"title": "我也提一个"})
        forbidden = await other.delete(f"{URL}/{task['id']}")

    assert [item["id"] for item in listed.json()["items"]] == [task["id"]]
    assert blocked.status_code == 403
    assert forbidden.status_code == 403
