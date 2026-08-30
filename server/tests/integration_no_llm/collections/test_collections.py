"""T-COLL-01：合集的 HTTP 契约，以及两处归属在真库上的事实。

这一层验的是内存替身验不了的东西：归属那两列的外键到底怎么行动——**删合集、删单都
不该带走对话**，只把对话上那一列置空。这条不变量写在表上（``ON DELETE SET NULL``），
所以只有真库测得出来。侧栏拓扑与治理者的审计列表也在这里验：它们都是真 SQL（窗口
函数、keyset 翻页），替身测不出来。
"""

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
    """治理者：持 users:manage，读得到别人的合集与对话。"""

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


async def column_of(pg_url: str, conversation_id: str, column: str) -> str | None:
    """直接回库里读对话上那一列——外键的动作只有库自己说得准。"""

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
    """密码注册默认 viewer：读得了自己的（一个也没有），但开不了新的。"""

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
    """别人的合集：列表里没有，读、改名、删除一律 404——403 会泄露它存在。"""

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
    """``scope=all`` 是治理者的全量视图；没有 users:manage 就 403。"""

    owner = await login_as_editor(client, pg_url)
    collection_id = await open_collection(client, "别人的口袋")
    assert (await client.get(URL, params={"scope": "all"})).status_code == 403

    async with make_client(app) as governor:
        await login_as_root(governor, pg_url)
        listed = await governor.get(URL, params={"scope": "all"})
        assert listed.status_code == 200
        rows = listed.json()["items"]
        assert [(item["id"], item["ownerUserId"]) for item in rows] == [(collection_id, owner)]
        # 不给 scope 就还是「我的」，治理者自己一个也没建。
        assert (await governor.get(URL)).json()["items"] == []


async def test_conversation_without_task_or_collection(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """直接开始创作：两处归属都空着，不属于任何单、没进合集。"""

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
    """编一个 id 发过来，由外键挡下来翻成 422——服务层不认识那两张表。"""

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
    """一段对话只待在一个口袋里，但随时能换，也能拿出来。"""

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
    """跑完才想起该记在哪张单下，是常事：这处归属不冻结，也能摘掉。"""

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
    """侧栏一次给全：合集分组（各带条数与最近几段）加上没归类的那些。"""

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
    # 组内也按最近活动倒序
    assert [item["id"] for item in groups[collection_id]["conversations"]] == [
        second["id"],
        first["id"],
    ]
    # 空合集留在拓扑里：刚建的口袋要看得见，不然没法往里放东西。
    assert groups[empty_id]["conversationCount"] == 0
    assert groups[empty_id]["conversations"] == []
    # 进了合集的不再出现在「没归类」那一区
    assert [item["id"] for item in sidebar["ungrouped"]] == [loose["id"]]


async def test_sidebar_only_shows_my_own(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    collection_id = await open_collection(client)
    await open_conversation(client, collectionId=collection_id)

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mia")
        sidebar = (await other.get(CONVERSATIONS)).json()

    assert sidebar == {"collections": [], "ungrouped": []}


async def test_audit_is_governor_only_and_filters(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """治理者按人、按单查全平台的对话；普通人连这个入口都进不来。"""

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
        # 只写一个日期（解析出来不带时区）按 UTC 读，不是 500。
        today = datetime.now(UTC).date().isoformat()
        assert (await governor.get(AUDIT, params={"since": today})).status_code == 200


async def test_audit_pages_by_cursor(app: FastAPI, client: httpx.AsyncClient, pg_url: str) -> None:
    """翻页位置是上一页最后一行的排序键，不是 offset。形状不对是 422。"""

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
    """复盘要看得到别人的对话历史与工作区；写入没有这个口子。"""

    await login_as_editor(client, pg_url)
    conversation_id = str((await open_conversation(client))["id"])

    async with make_client(app) as governor:
        await login_as_root(governor, pg_url)
        assert (
            await governor.get(f"{CONVERSATIONS}/{conversation_id}/messages")
        ).status_code == 200
        assert (
            await governor.get(f"{CONVERSATIONS}/{conversation_id}/workspace/files")
        ).status_code == 200
        # 只读：改别人的对话仍然当作不存在。
        assert (
            await governor.patch(f"{CONVERSATIONS}/{conversation_id}", json={"title": "我来改"})
        ).status_code == 404


async def test_deleting_collection_only_clears_the_column(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """删合集不带走对话——口袋没了，东西还在。这条由表上的 SET NULL 保证。"""

    await login_as_editor(client, pg_url)
    collection_id = await open_collection(client)
    conversation = await open_conversation(client, collectionId=collection_id)
    conversation_id = str(conversation["id"])

    assert (await client.delete(f"{URL}/{collection_id}")).status_code == 204

    assert await column_of(pg_url, conversation_id, "collection_id") is None
    sidebar = (await client.get(CONVERSATIONS)).json()
    assert [item["id"] for item in sidebar["ungrouped"]] == [conversation_id]


async def test_deleting_draft_task_only_clears_the_column(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """删单同理：为它跑过的对话留着，只是不再指向任何单。"""

    await login_as_editor(client, pg_url)
    task_id = await open_task(client)
    conversation = await open_conversation(client, taskId=task_id)
    conversation_id = str(conversation["id"])

    assert (await client.delete(f"{TASKS}/{task_id}")).status_code == 204

    assert await column_of(pg_url, conversation_id, "task_id") is None


async def test_attempts_of_a_task_are_listed_in_order_and_stay_private(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """一张单下面的尝试按开始时间正序——「第几次」就是这个顺序。

    而且只列自己的：一张单人人可见，不等于这张单下面谁跑过什么也人人可见。别人的要看
    走 ``/conversations/audit?taskId=``。
    """

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
