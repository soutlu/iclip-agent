"""对话的 HTTP 契约与真库事实：建/列/改名/删，归属收敛，删除连带清工作区。

这一层不需要 agent：对话只是一张自己的表，跑不跑得起来是 agents 那边的事。
"""

from __future__ import annotations

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.integration_no_llm.conftest import (
    make_client,
    register_and_login,
    set_roles_in_db,
)

URL = "/conversations"
AGENT_ID = "storyboard"


async def login_as_editor(client: httpx.AsyncClient, pg_url: str, *, username: str = "luke") -> str:
    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email)
    await set_roles_in_db(pg_url, email, ["editor"])
    return user_id


async def create(client: httpx.AsyncClient, **body: object) -> httpx.Response:
    return await client.post(URL, json={"agentId": AGENT_ID, **body})


async def test_anonymous_is_rejected(client: httpx.AsyncClient) -> None:
    assert (await create(client)).status_code == 401


async def test_viewer_cannot_open_a_conversation(client: httpx.AsyncClient) -> None:
    """密码注册默认 viewer：能看列表，但开不了新对话。"""

    await register_and_login(client)
    opened = await create(client)
    listed = await client.get(URL)

    assert opened.status_code == 403
    assert (listed.status_code, listed.json()) == (200, {"items": []})


async def test_open_list_rename_delete(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)

    opened = await create(client)
    assert opened.status_code == 201, opened.text
    conversation = opened.json()["conversation"]
    # id 由服务端发放，名字有个默认值，还没发过消息所以没有最近运行。
    assert conversation["agentId"] == AGENT_ID
    assert conversation["title"]
    assert conversation["lastRunId"] is None

    renamed = await client.patch(f"{URL}/{conversation['id']}", json={"title": "开场那段"})
    assert renamed.status_code == 200
    assert renamed.json()["conversation"]["title"] == "开场那段"

    listed = await client.get(URL)
    assert [item["title"] for item in listed.json()["items"]] == ["开场那段"]

    removed = await client.delete(f"{URL}/{conversation['id']}")
    assert removed.status_code == 204
    assert (await client.get(URL)).json()["items"] == []


async def test_title_can_be_given_at_creation(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)
    opened = await create(client, title="第三幕")
    assert opened.json()["conversation"]["title"] == "第三幕"


async def test_list_is_most_recent_first(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)
    first = (await create(client, title="早的")).json()["conversation"]
    await create(client, title="晚的")
    # 改名也算一次活动：它把「早的」顶回最前面。
    await client.patch(f"{URL}/{first['id']}", json={"title": "又动过的"})

    listed = await client.get(URL)
    assert [item["title"] for item in listed.json()["items"]] == ["又动过的", "晚的"]


async def test_list_can_be_searched_by_title(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)
    await create(client, title="夏季亚麻系列广告")
    await create(client, title="通勤背包短视频")
    await create(client, title="亚麻衬衫二剪")

    hit = await client.get(URL, params={"q": "亚麻"})
    # 命中仍按最近活动倒序
    assert [item["title"] for item in hit.json()["items"]] == ["亚麻衬衫二剪", "夏季亚麻系列广告"]
    # % 是普通字符不是通配符；只给空白等于没筛
    assert (await client.get(URL, params={"q": "%"})).json()["items"] == []
    assert len((await client.get(URL, params={"q": "  "})).json()["items"]) == 3


async def test_search_only_covers_my_own_conversations(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url, username="luke")
    await create(client, title="亚麻衬衫二剪")

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mia")
        assert (await other.get(URL, params={"q": "亚麻"})).json()["items"] == []


async def test_another_users_conversation_is_invisible(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """别人的对话：列表里没有，改名和删除都是 404（不是 403——那会泄露它存在）。"""

    await login_as_editor(client, pg_url)
    mine = (await create(client)).json()["conversation"]["id"]

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mallory")
        listed = await other.get(URL)
        renamed = await other.patch(f"{URL}/{mine}", json={"title": "归我了"})
        removed = await other.delete(f"{URL}/{mine}")

    assert listed.json()["items"] == []
    assert (renamed.status_code, removed.status_code) == (404, 404)


async def test_delete_takes_the_workspace_with_it(client: httpx.AsyncClient, pg_url: str) -> None:
    """删对话时，agent 在这段对话里写下的稿子一起删掉。

    工作区靠一个拼出来的命名空间认领地盘，两张表之间没有外键，所以这条连带关系
    只能由代码保证——它断了不会有任何报错，只会留下一堆再也没人看得见的文件。
    """

    user_id = await login_as_editor(client, pg_url)
    kept = (await create(client, title="留着的")).json()["conversation"]["id"]
    doomed = (await create(client, title="要删的")).json()["conversation"]["id"]

    engine = create_async_engine(pg_url)
    try:
        async with engine.begin() as conn:
            for conversation_id in (kept, doomed):
                await conn.execute(
                    text(
                        "INSERT INTO agent_runtime.workspace_files "
                        "(namespace, path, content, version, created_at, updated_at) "
                        "VALUES (:ns, '分镜.md', '稿子', 1, now(), now())"
                    ),
                    {"ns": f"{user_id}/{conversation_id}"},
                )

        assert (await client.delete(f"{URL}/{doomed}")).status_code == 204

        async with engine.connect() as conn:
            left = (
                (
                    await conn.execute(
                        text(
                            "SELECT namespace FROM agent_runtime.workspace_files "
                            "WHERE namespace LIKE :prefix"
                        ),
                        {"prefix": f"{user_id}/%"},
                    )
                )
                .scalars()
                .all()
            )
    finally:
        await engine.dispose()

    # 只剩留着那段对话的稿子：删除既没漏掉、也没多删。
    assert left == [f"{user_id}/{kept}"]


async def test_unknown_conversation_is_404(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)
    missing = "00000000-0000-0000-0000-000000000000"
    assert (await client.delete(f"{URL}/{missing}")).status_code == 404
    assert (await client.patch(f"{URL}/{missing}", json={"title": "x"})).status_code == 404


async def test_malformed_payload_is_422(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)
    assert (await client.post(URL, json={"agentId": ""})).status_code == 422
    assert (await client.post(URL, json={"nope": 1})).status_code == 422


async def seed_workspace_files(pg_url: str, namespace: str, files: dict[str, str]) -> None:
    """直接往工作区表里放几份稿子，装作 agent 在这段对话里写过。"""

    engine = create_async_engine(pg_url)
    try:
        async with engine.begin() as conn:
            for path, content in files.items():
                await conn.execute(
                    text(
                        "INSERT INTO agent_runtime.workspace_files "
                        "(namespace, path, content, version, created_at, updated_at) "
                        "VALUES (:ns, :path, :content, 1, now(), now())"
                    ),
                    {"ns": namespace, "path": path, "content": content},
                )
    finally:
        await engine.dispose()


async def test_workspace_files_can_be_listed_and_read(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """界面上的工作区面板靠这两个端点：列出这段对话里写下的文件，再按路径读正文。

    只看得到这一段对话的：同一个人另一段对话里的稿子不混进来。路径带 ``/`` 走查询串，
    这里用带目录的路径把编解码那一趟也走一遍。
    """

    user_id = await login_as_editor(client, pg_url)
    mine = (await create(client, title="这段")).json()["conversation"]["id"]
    other = (await create(client, title="另一段")).json()["conversation"]["id"]
    await seed_workspace_files(
        pg_url, f"{user_id}/{mine}", {"分镜/第一集.md": "第一集的稿子", "提纲.md": "三幕"}
    )
    await seed_workspace_files(pg_url, f"{user_id}/{other}", {"别的.md": "不该出现"})

    listed = await client.get(f"{URL}/{mine}/workspace/files")
    assert listed.status_code == 200, listed.text
    files = listed.json()["files"]
    # 按码点排（分 < 提），不是按写入顺序。
    assert [item["path"] for item in files] == ["分镜/第一集.md", "提纲.md"]
    assert {item["version"] for item in files} == {1}
    assert all(item["sizeBytes"] > 0 and item["updatedAt"] for item in files)

    read = await client.get(f"{URL}/{mine}/workspace/file", params={"path": "分镜/第一集.md"})
    assert read.status_code == 200, read.text
    assert read.json() == {
        "file": {"path": "分镜/第一集.md", "content": "第一集的稿子", "version": 1}
    }

    # 另一段对话只看得到它自己的；一份都没写过的是空列表，不是 404。
    other_files = (await client.get(f"{URL}/{other}/workspace/files")).json()["files"]
    assert [item["path"] for item in other_files] == ["别的.md"]
    empty = (await create(client, title="空的")).json()["conversation"]["id"]
    assert (await client.get(f"{URL}/{empty}/workspace/files")).json() == {"files": []}

    # 没有这个文件是 404；路径不合语法是 422（用户给的输入，不能漏成 500）。
    missing = await client.get(f"{URL}/{mine}/workspace/file", params={"path": "没有.md"})
    malformed = await client.get(f"{URL}/{mine}/workspace/file", params={"path": "../越界.md"})
    assert (missing.status_code, malformed.status_code) == (404, 422)

    # 别人的对话：两个端点都是 404，和其他端点同一个口径。
    async with make_client(app) as stranger:
        await login_as_editor(stranger, pg_url, username="mallory")
        listed_by_stranger = await stranger.get(f"{URL}/{mine}/workspace/files")
        read_by_stranger = await stranger.get(
            f"{URL}/{mine}/workspace/file", params={"path": "提纲.md"}
        )
    assert (listed_by_stranger.status_code, read_by_stranger.status_code) == (404, 404)


async def test_workspace_files_require_login(client: httpx.AsyncClient) -> None:
    some = "00000000-0000-0000-0000-000000000000"
    assert (await client.get(f"{URL}/{some}/workspace/files")).status_code == 401
    assert (
        await client.get(f"{URL}/{some}/workspace/file", params={"path": "x"})
    ).status_code == 401
