"""T-PROJ-01：项目的 HTTP 契约，以及两处归属在真库上的事实。

这一层验的是内存替身验不了的东西：归属那两列的外键到底怎么行动——**删项目、删单都
不该带走会话**，只把会话上那一列置空。这条不变量写在表上（``ON DELETE SET NULL``），
所以只有真库测得出来。
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

URL = "/projects"
CONVERSATIONS = "/conversations"
TASKS = "/tasks"
AGENT_ID = "storyboard"
MISSING_ID = "00000000-0000-0000-0000-000000000000"


async def login_as_editor(client: httpx.AsyncClient, pg_url: str, *, username: str = "luke") -> str:
    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email)
    await set_roles_in_db(pg_url, email, ["editor"])
    return user_id


async def open_project(client: httpx.AsyncClient, name: str = "2026 春季童鞋") -> str:
    created = await client.post(URL, json={"name": name})
    assert created.status_code == 201, created.text
    return str(created.json()["project"]["id"])


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
    """直接回库里读会话上那一列——外键的动作只有库自己说得准。"""

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
    """密码注册默认 viewer：项目人人可见，但开不了新的。"""

    await register_and_login(client)
    opened = await client.post(URL, json={"name": "偷偷开一个"})
    listed = await client.get(URL)

    assert opened.status_code == 403
    assert (listed.status_code, listed.json()) == (200, {"items": []})


async def test_open_read_rename_delete(client: httpx.AsyncClient, pg_url: str) -> None:
    creator = await login_as_editor(client, pg_url)

    project_id = await open_project(client)
    read = await client.get(f"{URL}/{project_id}")
    assert read.status_code == 200
    assert read.json()["project"]["creatorUserId"] == creator

    renamed = await client.patch(f"{URL}/{project_id}", json={"name": "2026 春夏童鞋"})
    assert renamed.status_code == 200
    assert renamed.json()["project"]["name"] == "2026 春夏童鞋"

    removed = await client.delete(f"{URL}/{project_id}")
    assert removed.status_code == 204
    assert (await client.get(f"{URL}/{project_id}")).status_code == 404


async def test_project_is_visible_to_everyone_but_only_creator_deletes(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """项目全公司可见（口径同需求单），但删除收紧到开它的人——它会动别人的会话。"""

    await login_as_editor(client, pg_url)
    project_id = await open_project(client)

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mia")
        # 看得见：不做属主过滤。
        assert (await other.get(f"{URL}/{project_id}")).status_code == 200
        # 改名是公事。
        assert (
            await other.patch(f"{URL}/{project_id}", json={"name": "改个名"})
        ).status_code == 200
        # 删除不是：看得见但不让删，403 而不是 404。
        assert (await other.delete(f"{URL}/{project_id}")).status_code == 403


async def test_conversation_without_task_or_project(client: httpx.AsyncClient, pg_url: str) -> None:
    """直接开始创作：两处归属都空着，不属于任何单、没放进项目。"""

    await login_as_editor(client, pg_url)
    conversation = await open_conversation(client)

    assert conversation["taskId"] is None
    assert conversation["projectId"] is None


async def test_conversation_carries_task_and_project(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    project_id = await open_project(client)
    task_id = await open_task(client)

    conversation = await open_conversation(client, taskId=task_id, projectId=project_id)

    assert conversation["taskId"] == task_id
    assert conversation["projectId"] == project_id


async def test_unknown_reference_is_rejected(client: httpx.AsyncClient, pg_url: str) -> None:
    """编一个 id 发过来，由外键挡下来翻成 422——服务层不认识那两张表。"""

    await login_as_editor(client, pg_url)

    bad_task = await client.post(CONVERSATIONS, json={"agentId": AGENT_ID, "taskId": MISSING_ID})
    bad_project = await client.post(
        CONVERSATIONS, json={"agentId": AGENT_ID, "projectId": MISSING_ID}
    )

    assert bad_task.status_code == 422
    assert bad_project.status_code == 422


async def test_conversation_moves_between_projects(client: httpx.AsyncClient, pg_url: str) -> None:
    """一段会话只待在一个口袋里，但随时能换，也能拿出来。"""

    await login_as_editor(client, pg_url)
    first = await open_project(client, "P1")
    second = await open_project(client, "P2")
    conversation = await open_conversation(client, projectId=first)
    endpoint = f"{CONVERSATIONS}/{conversation['id']}/project"

    moved = await client.put(endpoint, json={"projectId": second})
    assert moved.status_code == 200
    assert moved.json()["conversation"]["projectId"] == second

    cleared = await client.put(endpoint, json={"projectId": None})
    assert cleared.status_code == 200
    assert cleared.json()["conversation"]["projectId"] is None


async def test_conversation_project_need_not_come_from_its_task(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """单挂的项目是新建会话时的默认值，不是围栏：挂别的项目照样存得下。"""

    await login_as_editor(client, pg_url)
    task_id = await open_task(client)
    on_task = await open_project(client, "单挂的这个")
    elsewhere = await open_project(client, "单没挂的那个")
    assert (
        await client.put(f"{TASKS}/{task_id}/projects", json={"projectIds": [on_task]})
    ).status_code == 200

    conversation = await open_conversation(client, taskId=task_id, projectId=elsewhere)

    assert conversation["projectId"] == elsewhere


async def test_deleting_project_only_clears_the_column(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """删项目不带走会话——口袋没了，东西还在。这条由表上的 SET NULL 保证。"""

    await login_as_editor(client, pg_url)
    project_id = await open_project(client)
    conversation = await open_conversation(client, projectId=project_id)
    conversation_id = str(conversation["id"])

    assert (await client.delete(f"{URL}/{project_id}")).status_code == 204

    assert await column_of(pg_url, conversation_id, "project_id") is None
    still_there = await client.get(CONVERSATIONS)
    assert [item["id"] for item in still_there.json()["items"]] == [conversation_id]


async def test_deleting_draft_task_only_clears_the_column(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """删单同理：别人为它跑过的对话留着，只是不再指向任何单。"""

    await login_as_editor(client, pg_url)
    task_id = await open_task(client)
    conversation = await open_conversation(client, taskId=task_id)
    conversation_id = str(conversation["id"])

    assert (await client.delete(f"{TASKS}/{task_id}")).status_code == 204

    assert await column_of(pg_url, conversation_id, "task_id") is None


async def test_task_projects_are_overwritten_and_deduped(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """PUT 是整体覆盖；重复的 id 不算错，落库时去重。"""

    await login_as_editor(client, pg_url)
    task_id = await open_task(client)
    first = await open_project(client, "P1")
    second = await open_project(client, "P2")
    endpoint = f"{TASKS}/{task_id}/projects"

    saved = await client.put(endpoint, json={"projectIds": [first, second, first]})
    assert saved.status_code == 200
    assert sorted(saved.json()["projectIds"]) == sorted([first, second])

    replaced = await client.put(endpoint, json={"projectIds": [second]})
    assert replaced.json()["projectIds"] == [second]

    cleared = await client.put(endpoint, json={"projectIds": []})
    assert cleared.json()["projectIds"] == []
    assert (await client.get(endpoint)).json()["projectIds"] == []


async def test_task_projects_reject_unknown_project(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)
    task_id = await open_task(client)

    refused = await client.put(f"{TASKS}/{task_id}/projects", json={"projectIds": [MISSING_ID]})

    assert refused.status_code == 422


async def test_attempts_of_a_task_are_listed_in_order_and_stay_private(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """一张单下面的尝试按开始时间正序——「第几次」就是这个顺序。

    而且只列自己的：一张单人人可见，不等于这张单下面谁跑过什么也人人可见。
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
