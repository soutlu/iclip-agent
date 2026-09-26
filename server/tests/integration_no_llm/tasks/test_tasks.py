"""验证需求单的数据库时钟、表约束、条件更新原子性和持久化往返。"""

from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.tasks.infra_sql import SqlTaskRepository
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.fork_lineage import make_user
from tests.helpers.pg import connected
from tests.helpers.tasks import INPUTS, URL, create, make_task


def future(days: int = 7) -> str:
    return (datetime.now(UTC) + timedelta(days=days)).isoformat()


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


async def test_client_minted_id_lands_published_without_a_deadline(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """机器链路自带 id、直接落已下发、不带期限，重发同一个 id 不新建第二张。"""

    await login_as_editor(client, pg_url)
    minted = str(uuid.uuid4())

    created = await create(client, id=minted, status="published", deadline=None)
    assert created.status_code == 201, created.text
    assert created.json()["task"]["id"] == minted
    assert created.json()["task"]["status"] == "published"
    assert created.json()["task"]["deadline"] is None

    again = await create(client, id=minted, status="published", deadline=None, title="另一个标题")
    assert again.status_code == 200, again.text
    assert again.json()["task"]["title"] == "秋冬新品短视频"

    listed = await client.get(URL)
    assert [item["id"] for item in listed.json()["items"]] == [minted]


async def test_inputs_survive_http_and_jsonb_round_trip(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    created = (await create(client)).json()["task"]
    read_back = (await client.get(f"{URL}/{created['id']}")).json()["task"]
    assert read_back["inputs"] == INPUTS
    async with connected(pg_url) as conn:
        stored = (
            await conn.execute(
                text("SELECT inputs FROM iclip.tasks WHERE id = CAST(:id AS uuid)"),
                {"id": created["id"]},
            )
        ).scalar_one()
    assert stored == INPUTS


async def test_timestamps_come_from_the_database_clock(engine: AsyncEngine) -> None:

    repo = SqlTaskRepository(engine)
    stale = datetime.now(UTC) - timedelta(days=365)
    draft = make_task(creator_user_id=await make_user(engine))

    task, _ = await repo.create_if_absent(replace(draft, created_at=stale, updated_at=stale))

    assert task.created_at.tzinfo is not None
    assert task.created_at > stale + timedelta(days=1), "应用传进来的时刻被数据库改写了"
    assert task.updated_at > stale + timedelta(days=1)


async def test_a_draft_without_a_deadline_can_be_published(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """期限可以不填，不填的草稿照样能发布。"""

    await login_as_editor(client, pg_url)
    task = (await create(client, deadline=None)).json()["task"]

    published = await client.post(f"{URL}/{task['id']}/publish")

    assert published.status_code == 200, published.text
    assert published.json()["task"]["status"] == "published"
    assert published.json()["task"]["deadline"] is None


async def test_a_deadline_in_the_past_cannot_be_published(
    client: httpx.AsyncClient, pg_url: str
) -> None:

    await login_as_editor(client, pg_url)
    task = (await create(client, deadline=future(-1))).json()["task"]

    refused = await client.post(f"{URL}/{task['id']}/publish")

    assert refused.status_code == 409, refused.text
    assert (await client.get(f"{URL}/{task['id']}")).json()["task"]["status"] == "draft"


async def test_status_guard_refuses_a_write_built_on_a_stale_status(engine: AsyncEngine) -> None:
    """服务读完状态再写，中间可能被别人改过；仓储按读到的状态条件写入，对不上就一行不动。"""

    repo = SqlTaskRepository(engine)
    draft, _ = await repo.create_if_absent(make_task(creator_user_id=await make_user(engine)))
    assert await repo.publish(draft.id) is not None
    confirmed = await repo.confirm(draft.id, user_id=draft.creator_user_id)
    assert confirmed is not None and confirmed.status == "confirmed"

    assert await repo.publish(draft.id) is None
    assert await repo.set_status(draft.id, expect="published", status="withdrawn") is None
    saved = await repo.save(
        draft.id, expect="draft", title="改个名", priority=1, deadline=None, inputs=draft.inputs
    )
    assert saved is None
    assert await repo.delete(draft.id, expect="draft") is False
    assert await repo.get(draft.id) == confirmed


@pytest.mark.parametrize(
    ("status", "deadline", "inputs", "constraint"),
    [
        ("nonsense", datetime.now(UTC), "{}", "tasks_status_check"),
        ("draft", None, "[]", "tasks_inputs_object_check"),
    ],
)
async def test_constraints_live_on_the_table(
    client: httpx.AsyncClient,
    pg_url: str,
    status: str,
    deadline: datetime | None,
    inputs: str,
    constraint: str,
) -> None:
    user_id = await login_as_editor(client, pg_url)
    statement = text(
        "INSERT INTO iclip.tasks"
        " (id, title, status, priority, deadline, creator_user_id, inputs, created_at, updated_at)"
        " VALUES (gen_random_uuid(), 't', :status, 0, :deadline, CAST(:owner AS uuid),"
        " CAST(:inputs AS jsonb), now(), now())"
    )
    with pytest.raises(DBAPIError) as raised:
        async with connected(pg_url) as conn:
            await conn.execute(
                statement,
                {"status": status, "owner": user_id, "deadline": deadline, "inputs": inputs},
            )
    assert constraint in str(raised.value)


async def test_a_task_outlives_nothing_silently(client: httpx.AsyncClient, pg_url: str) -> None:
    """需求单创建者外键使用 RESTRICT，避免删除账号破坏业务记录。"""

    user_id = await login_as_editor(client, pg_url)
    await create(client)

    with pytest.raises(DBAPIError) as raised:
        async with connected(pg_url) as conn:
            await conn.execute(
                text("DELETE FROM iclip.users WHERE id = CAST(:id AS uuid)"), {"id": user_id}
            )
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
        blocked = await other.post(URL, json={"title": "我也提一个", "inputs": INPUTS})
        forbidden = await other.delete(f"{URL}/{task['id']}")

    assert [item["id"] for item in listed.json()["items"]] == [task["id"]]
    assert blocked.status_code == 403
    assert forbidden.status_code == 403


async def test_list_pages_by_cursor_and_reads_a_batch_by_ids(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """数据库时钟下依次建三张，按建立时间倒序翻页，续页不重不漏；``ids`` 批量读取只回点名的。"""

    await login_as_editor(client, pg_url)
    created = [(await create(client, title=f"第 {i} 张")).json()["task"]["id"] for i in range(3)]

    first = (await client.get(URL, params={"limit": 2})).json()
    assert [item["id"] for item in first["items"]] == created[:0:-1]
    assert first["total"] == 3 and first["nextCursor"] is not None

    rest = (await client.get(URL, params={"limit": 2, "cursor": first["nextCursor"]})).json()
    assert [item["id"] for item in rest["items"]] == created[:1]
    assert rest["total"] == 3 and rest["nextCursor"] is None

    batch = (await client.get(URL, params=(("ids", created[0]), ("ids", created[2])))).json()
    assert [item["id"] for item in batch["items"]] == [created[2], created[0]]
    assert batch["total"] == 2


async def test_tasks_made_at_the_same_moment_page_by_id(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """同一时刻建的按 id 倒序兜底；续页接着这个排序键，不跳行也不重行。"""

    await login_as_editor(client, pg_url)
    low, high = map(str, sorted(uuid.uuid4() for _ in range(2)))
    for minted in (low, high):
        assert (await create(client, id=minted)).status_code == 201
    async with connected(pg_url) as conn:
        await conn.execute(text("UPDATE iclip.tasks SET created_at = now()"))

    whole = (await client.get(URL, params={"limit": 2})).json()
    first = (await client.get(URL, params={"limit": 1})).json()
    rest = (await client.get(URL, params={"limit": 1, "cursor": first["nextCursor"]})).json()

    assert [item["id"] for item in whole["items"]] == [high, low]
    assert [item["id"] for page in (first, rest) for item in page["items"]] == [high, low]


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
