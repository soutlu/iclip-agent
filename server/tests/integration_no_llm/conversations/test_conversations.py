"""验证对话 HTTP 契约、归属和删除时的工作区清理；无需装配 Agent。"""

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
    await client.patch(f"{URL}/{first['id']}", json={"title": "又动过的"})

    listed = await client.get(SEARCH)
    assert [item["title"] for item in listed.json()["items"]] == ["又动过的", "晚的"]


async def test_list_can_be_searched_by_title(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as_editor(client, pg_url)
    await create(client, title="夏季亚麻系列广告")
    await create(client, title="通勤背包短视频")
    await create(client, title="亚麻衬衫二剪")

    hit = await client.get(SEARCH, params={"q": "亚麻"})
    assert [item["title"] for item in hit.json()["items"]] == ["亚麻衬衫二剪", "夏季亚麻系列广告"]
    # % 按字面量匹配，纯空白查询不筛选。
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
    """他人会话返回 404，避免通过 403 泄漏存在性。"""

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
    """工作区与素材台账按命名空间归属会话且没有外键，级联删除须由应用保证。"""

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
                await conn.execute(
                    text(
                        "INSERT INTO agent_runtime.materials (namespace, url, kind) "
                        "VALUES (:ns, 'https://cdn.test/style.jpg', 'image')"
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
            materials = (
                (
                    await conn.execute(
                        text(
                            "SELECT namespace FROM agent_runtime.materials "
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

    assert left == [f"{user_id}/{kept}"]
    assert materials == [f"{user_id}/{kept}"]


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
    """直接插入会话工作区文件。"""

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
    """工作区端点按会话隔离；嵌套路径覆盖查询参数编解码。"""

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
    # 按 Unicode 码点排序，分在提之前。
    assert [item["path"] for item in files] == ["分镜/第一集.md", "提纲.md"]
    assert {item["version"] for item in files} == {1}
    assert all(item["sizeBytes"] > 0 and item["updatedAt"] for item in files)

    read = await client.get(f"{URL}/{mine}/workspace/file", params={"path": "分镜/第一集.md"})
    assert read.status_code == 200, read.text
    assert read.json() == {
        "file": {"path": "分镜/第一集.md", "content": "第一集的稿子", "version": 1}
    }

    other_files = (await client.get(f"{URL}/{other}/workspace/files")).json()["files"]
    assert [item["path"] for item in other_files] == ["别的.md"]
    empty = (await create(client, title="空的")).json()["conversation"]["id"]
    assert (await client.get(f"{URL}/{empty}/workspace/files")).json() == {"files": []}

    missing = await client.get(f"{URL}/{mine}/workspace/file", params={"path": "没有.md"})
    malformed = await client.get(f"{URL}/{mine}/workspace/file", params={"path": "../越界.md"})
    assert (missing.status_code, malformed.status_code) == (404, 422)

    async with make_client(app) as stranger:
        await login_as_editor(stranger, pg_url, username="mallory")
        listed_by_stranger = await stranger.get(f"{URL}/{mine}/workspace/files")
        read_by_stranger = await stranger.get(
            f"{URL}/{mine}/workspace/file", params={"path": "提纲.md"}
        )
    assert (listed_by_stranger.status_code, read_by_stranger.status_code) == (404, 404)


def shots_document(*, image_url: str, index: int = 1) -> str:
    """与 write_video_shots 一致的文档；非 1 的 index 用于构造编号不连续场景。"""

    return json.dumps(
        {
            "aspectRatio": "9:16",
            "shots": [
                {
                    "index": index,
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
    """写回使用版本 CAS，冲突与文件不存在均返回 409，不能隐式新建文件。"""

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
    """写回沿用交付形状校验；非规范路径可能绕过 video_shot.json 校验，必须拒绝。"""

    user_id = await login_as_editor(client, pg_url)
    mine = (await create(client, title="这段")).json()["conversation"]["id"]
    frame_url = "https://cdn.test/frames/s1-1.jpg"
    await seed_workspace_files(
        pg_url, f"{user_id}/{mine}", {"video_shot.json": shots_document(image_url=frame_url)}
    )

    swapped = await client.put(
        f"{URL}/{mine}/workspace/file",
        json={
            "path": "video_shot.json",
            "content": shots_document(image_url="https://cdn.test/另一张.jpg"),
            "expectedVersion": 1,
        },
    )
    assert swapped.status_code == 200, "用户换帧是从自己的记录里挑的，不再问一遍地址哪来的"

    broken = await client.put(
        f"{URL}/{mine}/workspace/file",
        json={
            "path": "video_shot.json",
            "content": shots_document(image_url=frame_url, index=2),
            "expectedVersion": 2,
        },
    )
    assert broken.status_code == 422
    assert "连续编号" in broken.json()["detail"], "校验器的原话要给到用户"

    sneaky = await client.put(
        f"{URL}/{mine}/workspace/file",
        json={
            "path": "/video_shot.json",
            "content": shots_document(image_url=frame_url),
            "expectedVersion": 2,
        },
    )
    assert sneaky.status_code == 422


async def test_workspace_file_write_is_owner_only(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:

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

    await login_as_editor(client, pg_url)
    conversation_id = (await create(client, title="第三幕")).json()["conversation"]["id"]

    assert await _title_row(pg_url, conversation_id) == ("第三幕", "custom")
