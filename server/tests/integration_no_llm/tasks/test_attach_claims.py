"""对话挂上需求单就是认领：待认领推到进行中，草稿不动，摘掉不清认领。"""

from __future__ import annotations

import httpx

from tests.helpers.auth import login_as_editor
from tests.helpers.tasks import URL, create

CONVERSATIONS = "/conversations"


async def read_task(client: httpx.AsyncClient, task_id: str) -> dict[str, object]:
    return (await client.get(f"{URL}/{task_id}")).json()["task"]


async def test_opening_a_conversation_under_a_published_task_claims_it(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    user_id = await login_as_editor(client, pg_url)
    task = (await create(client, status="published")).json()["task"]

    opened = await client.post(CONVERSATIONS, json={"agentId": "storyboard", "taskId": task["id"]})
    assert opened.status_code == 201, opened.text

    after = await read_task(client, task["id"])
    assert after["status"] == "confirmed"
    assert after["assigneeUserIds"] == [user_id]


async def test_attaching_later_claims_too_and_detaching_keeps_the_claim(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    user_id = await login_as_editor(client, pg_url)
    task = (await create(client, status="published")).json()["task"]
    opened = await client.post(CONVERSATIONS, json={"agentId": "storyboard"})
    conversation_id = opened.json()["conversation"]["id"]

    attached = await client.put(
        f"{CONVERSATIONS}/{conversation_id}/task", json={"taskId": task["id"]}
    )
    assert attached.status_code == 200, attached.text
    assert (await read_task(client, task["id"]))["assigneeUserIds"] == [user_id]

    detached = await client.put(f"{CONVERSATIONS}/{conversation_id}/task", json={"taskId": None})
    assert detached.status_code == 200, detached.text
    after = await read_task(client, task["id"])
    assert after["status"] == "confirmed"
    assert after["assigneeUserIds"] == [user_id]


async def test_a_draft_is_attachable_but_not_claimed(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    draft = (await create(client)).json()["task"]

    opened = await client.post(CONVERSATIONS, json={"agentId": "storyboard", "taskId": draft["id"]})
    assert opened.status_code == 201, opened.text

    after = await read_task(client, draft["id"])
    assert after["status"] == "draft"
    assert after["assigneeUserIds"] == []
