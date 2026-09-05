"""验证合集 HTTP 契约、SET NULL 外键、侧栏拓扑和审计分页。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.helpers.tasks import STYLE_NO
from tests.integration_no_llm.conftest import (
    make_client,
    register_and_login,
    set_roles_in_db,
)

URL = "/collections"
CONVERSATIONS = "/conversations"
AUDIT = f"{CONVERSATIONS}/audit"
TASKS = "/tasks"
AGENT_ID = "storyboard"
MISSING_ID = "00000000-0000-0000-0000-000000000000"


async def login_as_editor(client: httpx.AsyncClient, pg_url: str, *, username: str = "luke") -> str:
    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email)
    await set_roles_in_db(pg_url, email, ["editor"])
    return user_id


async def login_as_root(client: httpx.AsyncClient, pg_url: str, *, username: str = "gov") -> str:

    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email)
    await set_roles_in_db(pg_url, email, ["root"])
    return user_id


async def open_collection(client: httpx.AsyncClient, name: str = "2026 春季童鞋") -> str:
    created = await client.post(URL, json={"name": name})
    assert created.status_code == 201, created.text
    return str(created.json()["collection"]["id"])


async def open_conversation(client: httpx.AsyncClient, **body: object) -> dict[str, object]:
    created = await client.post(CONVERSATIONS, json={"agentId": AGENT_ID, **body})
    assert created.status_code == 201, created.text
    return dict(created.json()["conversation"])


async def open_task(client: httpx.AsyncClient) -> str:
    created = await client.post(
        TASKS,
        json={
            "title": "儿童运动凉鞋多场景卖点",
            "styleNo": STYLE_NO,
            "brief": {"requirementDescription": "海边多视角"},
            "deadline": (datetime.now(UTC) + timedelta(days=7)).isoformat(),
        },
    )
    assert created.status_code == 201, created.text
    return str(created.json()["task"]["id"])


async def plant_job(
    pg_url: str, *, owner: str, conversation_id: str, status: str, prompt_id: str
) -> None:
    """直接插入任务状态供侧栏筛选使用；本测试未装配 Agent。"""

    engine = create_async_engine(pg_url)
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.agent_jobs "
                    "(prompt_id, conversation_id, agent_id, owner_user_id, content, status, "
                    " run_id, created_at, finished_at) "
                    "VALUES (:prompt_id, :conversation_id, :agent_id, :owner, '[]', :status, "
                    " :run_id, now(), :finished_at)"
                ),
                {
                    "prompt_id": prompt_id,
                    "conversation_id": conversation_id,
                    "agent_id": AGENT_ID,
                    "owner": owner,
                    "status": status,
                    "run_id": f"{AGENT_ID}-{prompt_id}",
                    "finished_at": None if status == "running" else datetime.now(UTC),
                },
            )
    finally:
        await engine.dispose()


async def column_of(pg_url: str, conversation_id: str, column: str) -> str | None:

    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            found = await conn.execute(
                text(f"SELECT {column} FROM iclip.conversations WHERE id = :id"),
                {"id": conversation_id},
            )
            value = found.scalar_one()
    finally:
        await engine.dispose()
    return None if value is None else str(value)


async def test_viewer_can_read_but_not_open(client: httpx.AsyncClient) -> None:

    await register_and_login(client)
    opened = await client.post(URL, json={"name": "偷偷开一个"})
    listed = await client.get(URL)

    assert opened.status_code == 403
    assert (listed.status_code, listed.json()) == (200, {"items": []})


async def test_open_read_rename_delete(client: httpx.AsyncClient, pg_url: str) -> None:
    owner = await login_as_editor(client, pg_url)

    collection_id = await open_collection(client)
    read = await client.get(f"{URL}/{collection_id}")
    assert read.status_code == 200
    assert read.json()["collection"]["ownerUserId"] == owner

    renamed = await client.patch(f"{URL}/{collection_id}", json={"name": "2026 春夏童鞋"})
    assert renamed.status_code == 200
    assert renamed.json()["collection"]["name"] == "2026 春夏童鞋"

    removed = await client.delete(f"{URL}/{collection_id}")
    assert removed.status_code == 204
    assert (await client.get(f"{URL}/{collection_id}")).status_code == 404


async def test_collection_belongs_to_its_owner_only(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:

    await login_as_editor(client, pg_url)
    collection_id = await open_collection(client)

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mia")
        assert (await other.get(URL)).json()["items"] == []
        assert (await other.get(f"{URL}/{collection_id}")).status_code == 404
        assert (
            await other.patch(f"{URL}/{collection_id}", json={"name": "归我了"})
        ).status_code == 404
        assert (await other.delete(f"{URL}/{collection_id}")).status_code == 404


async def test_governor_sees_every_collection(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:

    owner = await login_as_editor(client, pg_url)
    collection_id = await open_collection(client, "别人的口袋")
    assert (await client.get(URL, params={"scope": "all"})).status_code == 403

    async with make_client(app) as governor:
        await login_as_root(governor, pg_url)
        listed = await governor.get(URL, params={"scope": "all"})
        assert listed.status_code == 200
        rows = listed.json()["items"]
        assert [(item["id"], item["ownerUserId"]) for item in rows] == [(collection_id, owner)]
        assert (await governor.get(URL)).json()["items"] == []


async def test_conversation_without_task_or_collection(
    client: httpx.AsyncClient, pg_url: str
) -> None:

    await login_as_editor(client, pg_url)
    conversation = await open_conversation(client)

    assert conversation["taskId"] is None
    assert conversation["collectionId"] is None


async def test_conversation_carries_task_and_collection(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    collection_id = await open_collection(client)
    task_id = await open_task(client)

    conversation = await open_conversation(client, taskId=task_id, collectionId=collection_id)

    assert conversation["taskId"] == task_id
    assert conversation["collectionId"] == collection_id


async def test_unknown_reference_is_rejected(client: httpx.AsyncClient, pg_url: str) -> None:

    await login_as_editor(client, pg_url)

    bad_task = await client.post(CONVERSATIONS, json={"agentId": AGENT_ID, "taskId": MISSING_ID})
    bad_collection = await client.post(
        CONVERSATIONS, json={"agentId": AGENT_ID, "collectionId": MISSING_ID}
    )

    assert bad_task.status_code == 422
    assert bad_collection.status_code == 422


async def test_conversation_moves_between_collections(
    client: httpx.AsyncClient, pg_url: str
) -> None:

    await login_as_editor(client, pg_url)
    first = await open_collection(client, "C1")
    second = await open_collection(client, "C2")
    conversation = await open_conversation(client, collectionId=first)
    endpoint = f"{CONVERSATIONS}/{conversation['id']}/collection"

    moved = await client.put(endpoint, json={"collectionId": second})
    assert moved.status_code == 200
    assert moved.json()["conversation"]["collectionId"] == second

    cleared = await client.put(endpoint, json={"collectionId": None})
    assert cleared.status_code == 200
    assert cleared.json()["conversation"]["collectionId"] is None


async def test_task_can_be_attached_after_the_fact(client: httpx.AsyncClient, pg_url: str) -> None:

    await login_as_editor(client, pg_url)
    task_id = await open_task(client)
    conversation = await open_conversation(client)
    endpoint = f"{CONVERSATIONS}/{conversation['id']}/task"

    attached = await client.put(endpoint, json={"taskId": task_id})
    assert attached.status_code == 200
    assert attached.json()["conversation"]["taskId"] == task_id
    listed = await client.get(f"{CONVERSATIONS}/by-task/{task_id}")
    assert [item["id"] for item in listed.json()["items"]] == [conversation["id"]]

    detached = await client.put(endpoint, json={"taskId": None})
    assert detached.json()["conversation"]["taskId"] is None
    assert (await client.put(endpoint, json={"taskId": MISSING_ID})).status_code == 422


async def test_sidebar_groups_by_collection(client: httpx.AsyncClient, pg_url: str) -> None:

    await login_as_editor(client, pg_url)
    collection_id = await open_collection(client, "春季系列")
    empty_id = await open_collection(client, "还没往里放东西")
    first = await open_conversation(client, title="第一段", collectionId=collection_id)
    second = await open_conversation(client, title="第二段", collectionId=collection_id)
    loose = await open_conversation(client, title="没归类的")

    sidebar = (await client.get(CONVERSATIONS)).json()

    groups = {item["id"]: item for item in sidebar["collections"]}
    assert set(groups) == {collection_id, empty_id}
    assert groups[collection_id]["conversationCount"] == 2
    assert [item["id"] for item in groups[collection_id]["page"]["items"]] == [
        second["id"],
        first["id"],
    ]
    assert groups[collection_id]["page"]["nextCursor"] is None
    # 空合集仍须显示，以便用户将会话移入。
    assert groups[empty_id]["conversationCount"] == 0
    assert groups[empty_id]["page"]["items"] == []
    assert sidebar["ungroupedCount"] == 1
    assert [item["id"] for item in sidebar["ungrouped"]["items"]] == [loose["id"]]


async def test_sidebar_filters_by_run_state(client: httpx.AsyncClient, pg_url: str) -> None:

    owner = await login_as_editor(client, pg_url)
    collection_id = await open_collection(client, "在跑的那些")
    running = await open_conversation(client, title="正在跑", collectionId=collection_id)
    done = await open_conversation(client, title="跑完了")
    await open_conversation(client, title="还没发过消息")
    await plant_job(
        pg_url,
        owner=owner,
        conversation_id=str(running["id"]),
        status="running",
        prompt_id="prm_state_running",
    )
    await plant_job(
        pg_url,
        owner=owner,
        conversation_id=str(done["id"]),
        status="completed",
        prompt_id="prm_state_done",
    )

    everything = (await client.get(CONVERSATIONS)).json()
    only_running = (await client.get(CONVERSATIONS, params={"state": "running"})).json()
    only_done = (await client.get(CONVERSATIONS, params={"state": "done"})).json()

    assert everything["ungroupedCount"] == 2
    assert only_running["collections"][0]["conversationCount"] == 1
    assert [item["id"] for item in only_running["collections"][0]["page"]["items"]] == [
        running["id"]
    ]
    assert (only_running["ungroupedCount"], only_running["ungrouped"]["items"]) == (0, [])
    assert only_done["collections"][0]["conversationCount"] == 0
    assert only_done["ungroupedCount"] == 1
    assert [item["id"] for item in only_done["ungrouped"]["items"]] == [done["id"]]
    assert only_done["ungrouped"]["items"][0]["activity"] == {
        "busy": False,
        "pendingInteraction": "none",
        "lastTurnReason": "completed",
    }

    paged_done = await client.get(f"{CONVERSATIONS}/ungrouped", params={"state": "done"})
    assert [item["id"] for item in paged_done.json()["items"]] == [done["id"]]
    in_collection = await client.get(
        f"{CONVERSATIONS}/by-collection/{collection_id}", params={"state": "done"}
    )
    assert in_collection.json()["items"] == []


async def test_sidebar_only_shows_my_own(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    collection_id = await open_collection(client)
    await open_conversation(client, collectionId=collection_id)

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mia")
        sidebar = (await other.get(CONVERSATIONS)).json()

    assert sidebar == {
        "collections": [],
        "ungroupedCount": 0,
        "ungrouped": {"items": [], "nextCursor": None},
    }


async def test_sidebar_pages_by_cursor(client: httpx.AsyncClient, pg_url: str) -> None:

    await login_as_editor(client, pg_url)
    collection_id = await open_collection(client)
    # 内嵌会话上限为 10、任务分页为 20；分别多建一条覆盖翻页边界。
    for index in range(11):
        await open_conversation(client, title=f"合集里第{index}段", collectionId=collection_id)
    for index in range(21):
        await open_conversation(client, title=f"没归类第{index}段")

    sidebar = (await client.get(CONVERSATIONS)).json()
    group = sidebar["collections"][0]

    assert (group["conversationCount"], len(group["page"]["items"])) == (11, 10)
    assert (sidebar["ungroupedCount"], len(sidebar["ungrouped"]["items"])) == (21, 20)

    more_in_collection = await client.get(
        f"{CONVERSATIONS}/by-collection/{collection_id}",
        params={"cursor": group["page"]["nextCursor"]},
    )
    assert len(more_in_collection.json()["items"]) == 1
    assert more_in_collection.json()["nextCursor"] is None

    more_ungrouped = await client.get(
        f"{CONVERSATIONS}/ungrouped", params={"cursor": sidebar["ungrouped"]["nextCursor"]}
    )
    assert len(more_ungrouped.json()["items"]) == 1

    seen = [
        item["id"] for item in [*sidebar["ungrouped"]["items"], *more_ungrouped.json()["items"]]
    ]
    assert len(set(seen)) == 21
    assert (
        await client.get(f"{CONVERSATIONS}/ungrouped", params={"cursor": "坏的"})
    ).status_code == 422


async def test_other_peoples_collection_pages_empty(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """不可见和不存在的合集均返回空分页，避免泄漏其存在性。"""

    await login_as_editor(client, pg_url)
    collection_id = await open_collection(client)
    await open_conversation(client, collectionId=collection_id)

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mia")
        theirs = await other.get(f"{CONVERSATIONS}/by-collection/{collection_id}")
        missing = await other.get(f"{CONVERSATIONS}/by-collection/{MISSING_ID}")

    assert theirs.status_code == 200
    assert theirs.json() == missing.json() == {"items": [], "nextCursor": None}


async def test_audit_is_governor_only_and_filters(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:

    owner = await login_as_editor(client, pg_url)
    task_id = await open_task(client)
    on_task = await open_conversation(client, taskId=task_id, title="挂单的")
    await open_conversation(client, title="没挂单的")
    assert (await client.get(AUDIT)).status_code == 403

    async with make_client(app) as governor:
        await login_as_root(governor, pg_url)
        await open_conversation(governor, title="治理者自己的")

        everything = (await governor.get(AUDIT)).json()["items"]
        assert len(everything) == 3
        assert {item["ownerUserId"] for item in everything} == {owner, everything[0]["ownerUserId"]}

        by_person = (await governor.get(AUDIT, params={"ownerUserId": owner})).json()["items"]
        assert {item["ownerUserId"] for item in by_person} == {owner}

        by_task = (await governor.get(AUDIT, params={"taskId": task_id})).json()["items"]
        assert [item["id"] for item in by_task] == [on_task["id"]]

        future = (datetime.now(UTC) + timedelta(days=1)).isoformat()
        assert (await governor.get(AUDIT, params={"since": future})).json()["items"] == []
        # 无时区日期按 UTC 解析。
        today = datetime.now(UTC).date().isoformat()
        assert (await governor.get(AUDIT, params={"since": today})).status_code == 200


async def test_audit_pages_by_cursor(app: FastAPI, client: httpx.AsyncClient, pg_url: str) -> None:

    await login_as_editor(client, pg_url)
    for index in range(3):
        await open_conversation(client, title=f"第{index}段")

    async with make_client(app) as governor:
        await login_as_root(governor, pg_url)
        first = (await governor.get(AUDIT, params={"limit": 2})).json()
        assert len(first["items"]) == 2
        assert first["nextCursor"]

        second = (
            await governor.get(AUDIT, params={"limit": 2, "cursor": first["nextCursor"]})
        ).json()
        assert len(second["items"]) == 1
        assert second["nextCursor"] is None
        ids = [item["id"] for item in [*first["items"], *second["items"]]]
        assert len(set(ids)) == 3

        assert (await governor.get(AUDIT, params={"cursor": "坏掉的"})).status_code == 422


async def test_governor_reads_other_peoples_history(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:

    await login_as_editor(client, pg_url)
    conversation_id = str((await open_conversation(client))["id"])

    async with make_client(app) as governor:
        await login_as_root(governor, pg_url)
        assert (
            await governor.get(f"{CONVERSATIONS}/{conversation_id}/transcript")
        ).status_code == 200
        assert (
            await governor.get(f"{CONVERSATIONS}/{conversation_id}/workspace/files")
        ).status_code == 200
        assert (
            await governor.patch(f"{CONVERSATIONS}/{conversation_id}", json={"title": "我来改"})
        ).status_code == 404
        assert (
            await governor.post(
                f"{CONVERSATIONS}/{conversation_id}/prompts",
                json={"prompt_id": "prm_gov", "content": [{"type": "text", "text": "替你发"}]},
            )
        ).status_code == 404


async def test_deleting_collection_only_clears_the_column(
    client: httpx.AsyncClient, pg_url: str
) -> None:

    await login_as_editor(client, pg_url)
    collection_id = await open_collection(client)
    conversation = await open_conversation(client, collectionId=collection_id)
    conversation_id = str(conversation["id"])

    assert (await client.delete(f"{URL}/{collection_id}")).status_code == 204

    assert await column_of(pg_url, conversation_id, "collection_id") is None
    sidebar = (await client.get(CONVERSATIONS)).json()
    assert [item["id"] for item in sidebar["ungrouped"]["items"]] == [conversation_id]


async def test_deleting_draft_task_only_clears_the_column(
    client: httpx.AsyncClient, pg_url: str
) -> None:

    await login_as_editor(client, pg_url)
    task_id = await open_task(client)
    conversation = await open_conversation(client, taskId=task_id)
    conversation_id = str(conversation["id"])

    assert (await client.delete(f"{TASKS}/{task_id}")).status_code == 204

    assert await column_of(pg_url, conversation_id, "task_id") is None


async def test_attempts_of_a_task_are_listed_in_order_and_stay_private(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """按开始时间列出需求单的个人创作；跨用户记录仅通过审计端点访问。"""

    await login_as_editor(client, pg_url)
    task_id = await open_task(client)
    first = await open_conversation(client, taskId=task_id, title="第一次")
    second = await open_conversation(client, taskId=task_id, title="第二次")
    await open_conversation(client, title="没挂单的")

    listed = await client.get(f"{CONVERSATIONS}/by-task/{task_id}")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["items"]] == [first["id"], second["id"]]

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mia")
        assert (await other.get(f"{CONVERSATIONS}/by-task/{task_id}")).json()["items"] == []
