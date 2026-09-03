"""对话的 HTTP 契约与真库事实：建/列/改名/删，归属收敛，删除连带清工作区。

这一层不需要 agent：对话只是一张自己的表，跑不跑得起来是 agents 那边的事。
"""

from __future__ import annotations

import json
import uuid

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.conversations.schemas import DEFAULT_TITLE
from tests.integration_no_llm.conftest import (
    make_client,
    register_and_login,
    set_roles_in_db,
)

URL = "/conversations"
SEARCH = f"{URL}/search"
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
    listed = await client.get(SEARCH)

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

    listed = await client.get(SEARCH)
    assert [item["title"] for item in listed.json()["items"]] == ["开场那段"]

    removed = await client.delete(f"{URL}/{conversation['id']}")
    assert removed.status_code == 204
    assert (await client.get(SEARCH)).json()["items"] == []


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

    listed = await client.get(SEARCH)
    assert [item["title"] for item in listed.json()["items"]] == ["又动过的", "晚的"]


async def test_list_can_be_searched_by_title(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)
    await create(client, title="夏季亚麻系列广告")
    await create(client, title="通勤背包短视频")
    await create(client, title="亚麻衬衫二剪")

    hit = await client.get(SEARCH, params={"q": "亚麻"})
    # 命中仍按最近活动倒序
    assert [item["title"] for item in hit.json()["items"]] == ["亚麻衬衫二剪", "夏季亚麻系列广告"]
    # % 是普通字符不是通配符；只给空白等于没筛
    assert (await client.get(SEARCH, params={"q": "%"})).json()["items"] == []
    assert len((await client.get(SEARCH, params={"q": "  "})).json()["items"]) == 3


async def test_search_only_covers_my_own_conversations(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url, username="luke")
    await create(client, title="亚麻衬衫二剪")

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mia")
        assert (await other.get(SEARCH, params={"q": "亚麻"})).json()["items"] == []


async def test_another_users_conversation_is_invisible(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """别人的对话：列表里没有，改名和删除都是 404（不是 403——那会泄露它存在）。"""

    await login_as_editor(client, pg_url)
    mine = (await create(client)).json()["conversation"]["id"]

    async with make_client(app) as other:
        await login_as_editor(other, pg_url, username="mallory")
        listed = await other.get(SEARCH)
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


def shots_document(*, image_url: str) -> str:
    """一份合规的镜头组 prompt 表，形状与 ``write_video_shots`` 交付出来的一致。"""

    return json.dumps(
        {
            "aspectRatio": "9:16",
            "shots": [
                {
                    "index": 1,
                    "prompt": "0-8s 全景 平视 固定，她走进门厅 @Image1。",
                    "seconds": 8,
                    "imageUrls": [image_url],
                }
            ],
        },
        ensure_ascii=False,
    )


async def test_workspace_file_can_be_written_back_with_the_version_it_was_read_at(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """面板改完整份写回：带着读到的版本号，写完版本加一。

    版本对不上是 409（agent 与用户会同时写同一份文件，不能静默覆盖）；文件不存在时任何
    版本都对不上，同样 409——不替调用方凭空新建一份。
    """

    user_id = await login_as_editor(client, pg_url)
    mine = (await create(client, title="这段")).json()["conversation"]["id"]
    await seed_workspace_files(pg_url, f"{user_id}/{mine}", {"提纲.md": "三幕"})

    written = await client.put(
        f"{URL}/{mine}/workspace/file",
        json={"path": "提纲.md", "content": "四幕", "expectedVersion": 1},
    )
    assert written.status_code == 200, written.text
    assert written.json() == {"file": {"path": "提纲.md", "content": "四幕", "version": 2}}

    read = await client.get(f"{URL}/{mine}/workspace/file", params={"path": "提纲.md"})
    assert read.json()["file"]["content"] == "四幕"

    stale = await client.put(
        f"{URL}/{mine}/workspace/file",
        json={"path": "提纲.md", "content": "五幕", "expectedVersion": 1},
    )
    assert stale.status_code == 409, stale.text

    absent = await client.put(
        f"{URL}/{mine}/workspace/file",
        json={"path": "还没有.md", "content": "x", "expectedVersion": 1},
    )
    assert absent.status_code == 409


async def test_workspace_file_write_checks_the_document_on_its_path(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """``video_shot.json`` 走交付工具那一关：帧地址必须是这段对话生成过的。

    不规范的路径写法一律拒：``/video_shot.json`` 与 ``video_shot.json`` 落同一个文件，
    放行前者就等于放出一条绕开校验的路。
    """

    user_id = await login_as_editor(client, pg_url)
    mine = (await create(client, title="这段")).json()["conversation"]["id"]
    frame_url = "https://cdn.test/frames/s1-1.jpg"
    await seed_workspace_files(
        pg_url,
        f"{user_id}/{mine}",
        {
            "frames/grids/job-1.json": json.dumps(
                {
                    "gridRecordVersion": 1,
                    "jobId": "job-1",
                    "frames": [{"no": "S1-1", "url": frame_url}],
                }
            ),
            "video_shot.json": shots_document(image_url=frame_url),
        },
    )

    good = await client.put(
        f"{URL}/{mine}/workspace/file",
        json={
            "path": "video_shot.json",
            "content": shots_document(image_url=frame_url),
            "expectedVersion": 1,
        },
    )
    assert good.status_code == 200, good.text

    made_up = await client.put(
        f"{URL}/{mine}/workspace/file",
        json={
            "path": "video_shot.json",
            "content": shots_document(image_url="https://cdn.test/编的.jpg"),
            "expectedVersion": 2,
        },
    )
    assert made_up.status_code == 422
    assert "generate_shot_frames" in made_up.json()["detail"], "校验器的原话要给到用户"

    sneaky = await client.put(
        f"{URL}/{mine}/workspace/file",
        json={
            "path": "/video_shot.json",
            "content": shots_document(image_url="https://cdn.test/编的.jpg"),
            "expectedVersion": 2,
        },
    )
    assert sneaky.status_code == 422


async def test_workspace_file_write_is_owner_only(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """别人的对话写不进去：看不见的一律 404，治理者看得见但只读，是 403。"""

    user_id = await login_as_editor(client, pg_url)
    mine = (await create(client, title="这段")).json()["conversation"]["id"]
    await seed_workspace_files(pg_url, f"{user_id}/{mine}", {"提纲.md": "三幕"})
    body = {"path": "提纲.md", "content": "我来改", "expectedVersion": 1}

    async with make_client(app) as stranger:
        await login_as_editor(stranger, pg_url, username="mallory")
        assert (await stranger.put(f"{URL}/{mine}/workspace/file", json=body)).status_code == 404

    async with make_client(app) as governor:
        await register_and_login(governor, username="gov", email="gov@example.com")
        await set_roles_in_db(pg_url, "gov@example.com", ["root"])
        assert (
            await governor.get(f"{URL}/{mine}/workspace/file", params={"path": "提纲.md"})
        ).status_code == 200, "治理者读得到"
        assert (await governor.put(f"{URL}/{mine}/workspace/file", json=body)).status_code == 403

    unchanged = await client.get(f"{URL}/{mine}/workspace/file", params={"path": "提纲.md"})
    assert unchanged.json()["file"] == {"path": "提纲.md", "content": "三幕", "version": 1}


async def test_workspace_files_require_login(client: httpx.AsyncClient) -> None:
    some = "00000000-0000-0000-0000-000000000000"
    assert (await client.get(f"{URL}/{some}/workspace/files")).status_code == 401
    assert (
        await client.get(f"{URL}/{some}/workspace/file", params={"path": "x"})
    ).status_code == 401


async def _title_row(pg_url: str, conversation_id: str) -> tuple[str, str]:
    """库里这一行现在的标题与它的来路。"""

    engine = create_async_engine(pg_url)
    try:
        async with engine.begin() as conn:
            row = (
                await conn.execute(
                    text(
                        "SELECT title, title_kind FROM iclip.conversations WHERE id = :id"
                    ).bindparams(id=uuid.UUID(conversation_id))
                )
            ).one()
        return str(row.title), str(row.title_kind)
    finally:
        await engine.dispose()


async def test_generated_title_is_written_once(client: httpx.AsyncClient, pg_url: str) -> None:
    """自动起的标题只落一次。

    第二次要是也能写进去，用户每跑一轮都会看到标题变来变去。
    """

    await login_as_editor(client, pg_url)
    conversation_id = (await create(client)).json()["conversation"]["id"]
    assert await _title_row(pg_url, conversation_id) == (DEFAULT_TITLE, "default")

    engine = create_async_engine(pg_url)
    try:
        repo = SqlConversationRepository(engine)
        assert (
            await repo.apply_generated_title(uuid.UUID(conversation_id), title="夜景延时") is True
        )
        assert await _title_row(pg_url, conversation_id) == ("夜景延时", "generated")

        assert (
            await repo.apply_generated_title(uuid.UUID(conversation_id), title="别的名字") is False
        )
        assert await _title_row(pg_url, conversation_id) == ("夜景延时", "generated")
    finally:
        await engine.dispose()


async def test_user_named_conversations_are_left_alone(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """用户自己起的名字不会被自动生成的盖掉。"""

    await login_as_editor(client, pg_url)
    conversation_id = (await create(client)).json()["conversation"]["id"]
    await client.patch(f"{URL}/{conversation_id}", json={"title": "开场那段"})
    assert await _title_row(pg_url, conversation_id) == ("开场那段", "custom")

    engine = create_async_engine(pg_url)
    try:
        repo = SqlConversationRepository(engine)
        assert (
            await repo.apply_generated_title(uuid.UUID(conversation_id), title="夜景延时") is False
        )
    finally:
        await engine.dispose()
    assert await _title_row(pg_url, conversation_id) == ("开场那段", "custom")


async def test_title_given_at_creation_counts_as_the_users(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """开对话时就给了名字的，同样不该被自动起的盖掉。"""

    await login_as_editor(client, pg_url)
    conversation_id = (await create(client, title="第三幕")).json()["conversation"]["id"]

    assert await _title_row(pg_url, conversation_id) == ("第三幕", "custom")
