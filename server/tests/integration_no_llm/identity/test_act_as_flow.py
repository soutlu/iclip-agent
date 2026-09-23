"""钥匙替人办事全链路：有权限的钥匙把记录落到 user_name 名下并建占位账号，本人 SSO 登录按用户名认领。"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.integration_no_llm.agents.waiting import settled
from tests.integration_no_llm.conftest import (
    make_client,
    register_and_login,
    set_roles_in_db,
)
from tests.integration_no_llm.tasks.test_tasks import INPUTS

ACT_AS_GRANTS = ["agent:run", "agent:read", "tasks:read", "tasks:write", "users:act_as"]
PLAIN_GRANTS = ["agent:run", "agent:read", "tasks:read", "tasks:write"]


async def issue_key(
    root: httpx.AsyncClient, pg_url: str, permissions: list[str]
) -> tuple[str, str]:
    """用这个客户端注册 luke、提成 root、签一把钥匙；返回 (luke 的 id, 钥匙明文)。"""

    luke_id = await register_and_login(root)
    await set_roles_in_db(pg_url, "luke@example.com", ["root"])
    created = await root.post("/api-keys", json={"name": "multiflow", "permissions": permissions})
    assert created.status_code == 201, created.text
    return luke_id, created.json()["apiKey"]["token"]


def machine(app: FastAPI, token: str) -> httpx.AsyncClient:
    client = make_client(app)
    client.headers["Authorization"] = f"Bearer {token}"
    return client


async def test_act_as_key_files_task_and_conversation_under_the_named_person(
    app: FastAPI, migrated_pg: str
) -> None:
    async with make_client(app) as root:
        luke_id, token = await issue_key(root, migrated_pg, ACT_AS_GRANTS)
        async with machine(app, token) as gateway:
            task = await gateway.post(
                "/tasks",
                json={
                    "title": "替 Shan.Hu 提的",
                    "inputs": INPUTS,
                    "status": "published",
                    "userName": "Shan.Hu",
                },
            )
            assert task.status_code == 201, task.text
            task_id = task.json()["task"]["id"]
            creator = task.json()["task"]["creatorUserId"]
            assert creator != luke_id

            opened = await gateway.post(
                "/conversations",
                json={"agentId": "storyboard", "taskId": task_id, "userName": "Shan.Hu"},
            )
            assert opened.status_code == 201, opened.text
            conversation_id = opened.json()["conversation"]["id"]

            # 挂上会话就是认领：创建者与认领人是同一个人，单子进入进行中。
            after = (await gateway.get(f"/tasks/{task_id}")).json()["task"]
            assert after["status"] == "confirmed"
            assert after["assigneeUserIds"] == [creator]

            # 能替任何人写的钥匙也读得到那个人的对话。
            files = await gateway.get(f"/conversations/{conversation_id}/workspace/files")
            assert files.status_code == 200, files.text

        # 占位账号：只有用户名，没有角色；钥匙属主自己的侧栏里没有替别人开的对话。
        users = (await root.get("/users")).json()["items"]
        placeholder = next(user for user in users if user["username"] == "Shan.Hu")
        assert placeholder["id"] == creator
        assert placeholder["roles"] == []
        assert (await root.get("/conversations/search")).json()["items"] == []


async def test_key_without_act_as_keeps_records_under_the_key_owner(
    app: FastAPI, migrated_pg: str
) -> None:
    async with make_client(app) as root:
        _, token = await issue_key(root, migrated_pg, PLAIN_GRANTS)
        async with machine(app, token) as gateway:
            opened = await gateway.post(
                "/conversations", json={"agentId": "storyboard", "userName": "Shan.Hu"}
            )
            assert opened.status_code == 201, opened.text

        assert len((await root.get("/conversations/search")).json()["items"]) == 1
        assert (await root.get("/users")).json()["total"] == 1


async def test_act_as_key_can_prompt_the_conversation_it_opened_for_someone(
    app: FastAPI, migrated_pg: str
) -> None:
    """上午出事的那条路：替人开的对话属主已换成他，同一把钥匙接着替他发消息必须还进得去。"""

    async with make_client(app) as root:
        _, token = await issue_key(root, migrated_pg, ACT_AS_GRANTS)
        async with machine(app, token) as gateway:
            opened = await gateway.post(
                "/conversations", json={"agentId": "storyboard", "userName": "Shan.Hu"}
            )
            conversation_id = opened.json()["conversation"]["id"]
            sent = await gateway.post(
                f"/conversations/{conversation_id}/prompts",
                json={
                    "prompt_id": "prm_act_as_1",
                    "content": [{"type": "text", "text": "你是谁"}],
                    "user_name": "Shan.Hu",
                },
            )
            assert sent.status_code == 200, sent.text
            await settled(gateway, conversation_id)

        owner = await job_owner(migrated_pg, conversation_id)
        users = (await root.get("/users")).json()["items"]
        assert owner == next(user["id"] for user in users if user["username"] == "Shan.Hu")


async def job_owner(pg_url: str, conversation_id: str) -> str:
    """这段对话最近一条消息记在谁名下。"""

    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            row = await conn.execute(
                text(
                    "SELECT owner_user_id FROM agent_runtime.agent_jobs"
                    " WHERE conversation_id = :conversation_id"
                ),
                {"conversation_id": conversation_id},
            )
            return str(row.scalar_one())
    finally:
        await engine.dispose()


async def test_browser_session_may_only_name_itself(client: httpx.AsyncClient, pg_url: str) -> None:
    await register_and_login(client)
    await set_roles_in_db(pg_url, "luke@example.com", ["editor"])

    someone_else = await client.post(
        "/conversations", json={"agentId": "storyboard", "userName": "Shan.Hu"}
    )
    assert someone_else.status_code == 422
    myself = await client.post("/conversations", json={"agentId": "storyboard", "userName": "luke"})
    assert myself.status_code == 201, myself.text


@pytest.fixture
def pms_transport() -> httpx.MockTransport | None:
    return None


class TestSsoAdoptsThePlaceholder:
    """本人日后 SSO 登录，名字对上占位账号就认领它：真邮箱补上，替他开的对话都在他侧栏里。"""

    @pytest.fixture
    def sso_transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={
                    "result": "OK",
                    "userSession": {
                        "innerUserId": 7,
                        "unionId": "u-7",
                        "name": "Shan.Hu",
                        "email": "shan.hu@corp.test",
                        "avatarUrl": "",
                    },
                },
            )
        )

    async def test_login_adopts_placeholder_and_its_records(
        self, sso_app: FastAPI, migrated_pg: str
    ) -> None:
        async with make_client(sso_app) as root:
            _, token = await issue_key(root, migrated_pg, ACT_AS_GRANTS)
            async with machine(sso_app, token) as gateway:
                opened = await gateway.post(
                    "/conversations",
                    json={"agentId": "storyboard", "title": "替他开的", "userName": "Shan.Hu"},
                )
                assert opened.status_code == 201, opened.text

        async with make_client(sso_app) as shan:
            callback = await shan.get("/auth/sso/callback", params={"jwt": "sso-jwt"})
            assert callback.status_code == 204, callback.text
            me = (await shan.get("/users/me")).json()["user"]
            assert me["username"] == "Shan.Hu"
            assert me["email"] == "shan.hu@corp.test"
            assert me["roles"] == ["editor"]
            listed = (await shan.get("/conversations/search")).json()["items"]
        assert [item["title"] for item in listed] == ["替他开的"]

        # 认领的是同一行，没有多出第二个账号。
        async with make_client(sso_app) as root:
            login = await root.post(
                "/auth/login", data={"username": "luke", "password": "password-123"}
            )
            assert login.status_code == 204, login.text
            assert (await root.get("/users")).json()["total"] == 2


class TestSsoLeavesASameNameRealAccountAlone:
    """SSO 无邮箱的真人与占位账号同域：同名新人首登另开账号，不接管他。"""

    @pytest.fixture
    def sso_transport(self) -> httpx.MockTransport:
        sessions = {
            "jwt-a": {"innerUserId": 7, "unionId": "u-7", "name": "Shan.Hu", "email": None},
            "jwt-b": {
                "innerUserId": 8,
                "unionId": "u-8",
                "name": "Shan.Hu",
                "email": "b@corp.test",
            },
        }

        def verify(request: httpx.Request) -> httpx.Response:
            user_session = {**sessions[request.url.params["jwt"]], "avatarUrl": ""}
            return httpx.Response(200, json={"result": "OK", "userSession": user_session})

        return httpx.MockTransport(verify)

    async def test_same_name_newcomer_gets_an_account_of_their_own(
        self, sso_app: FastAPI, migrated_pg: str
    ) -> None:
        first = await sso_login(sso_app, "jwt-a")
        # 前提：A 的显示名成了用户名，B 首登按这个名字查得到 A 这一行。
        assert first["username"] == "Shan.Hu"
        assert first["email"] == "u-7@sso.iclip.example"

        newcomer = await sso_login(sso_app, "jwt-b")
        assert newcomer["email"] == "b@corp.test"
        assert newcomer["id"] != first["id"]

        again = await sso_login(sso_app, "jwt-a")
        assert again["id"] == first["id"]
        assert again["email"] == "u-7@sso.iclip.example"

        async with make_client(sso_app) as root:
            await register_and_login(root)
            await set_roles_in_db(migrated_pg, "luke@example.com", ["root"])
            assert (await root.get("/users")).json()["total"] == 3


async def sso_login(app: FastAPI, jwt: str) -> dict[str, Any]:
    """走一次 SSO 回调，返回登录后的 ``/users/me``。"""

    async with make_client(app) as client:
        callback = await client.get("/auth/sso/callback", params={"jwt": jwt})
        assert callback.status_code == 204, callback.text
        return (await client.get("/users/me")).json()["user"]
