"""用户管理面：分页信封、users:manage 门控、自我保护规则。"""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tests.integration_no_llm.conftest import (
    make_client,
    register_and_login,
    set_role_in_db,
)


async def test_users_page_requires_manage_permission(
    client: httpx.AsyncClient,
) -> None:
    await register_and_login(client)
    assert (await client.get("/users")).status_code == 403


async def test_admin_lists_users_with_page_envelope(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await register_and_login(client)
    await set_role_in_db(migrated_pg, "luke@example.com", "admin")

    async with make_client(app) as admin:
        await admin.post("/auth/login", data={"username": "luke", "password": "password-123"})
        page = await admin.get("/users", params={"page": 1, "pageSize": 10})
    assert page.status_code == 200
    payload = page.json()
    assert payload["total"] == 1
    assert payload["page"] == 1
    assert payload["pageSize"] == 10
    item = payload["items"][0]
    assert item["role"] == "admin"
    assert item["isActive"] is True
    assert "createdAt" in item


async def test_admin_updates_role_and_self_protection(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    admin_id = await register_and_login(client)
    await set_role_in_db(migrated_pg, "luke@example.com", "admin")

    async with make_client(app) as admin:
        await admin.post("/auth/login", data={"username": "luke", "password": "password-123"})
        other = await admin.post(
            "/auth/register",
            json={
                "email": "member@example.com",
                "password": "password-123",
                "username": "member",
            },
        )
        other_id = other.json()["id"]

        promoted = await admin.patch(f"/users/{other_id}", json={"role": "editor"})
        assert promoted.status_code == 200
        assert promoted.json()["user"]["role"] == "editor"

        # 不能撤销自己的管理员角色 / 停用自己（wire 契约为 400）
        assert (await admin.patch(f"/users/{admin_id}", json={"role": "viewer"})).status_code == 400
        assert (
            await admin.patch(f"/users/{admin_id}", json={"isActive": False})
        ).status_code == 400

        deactivated = await admin.patch(f"/users/{other_id}", json={"isActive": False})
        assert deactivated.status_code == 200
        assert deactivated.json()["user"]["isActive"] is False

    # 被停用用户的会话即时失效（下一次请求加载 active 用户失败）
    async with make_client(app) as member:
        login = await member.post(
            "/auth/login", data={"username": "member", "password": "password-123"}
        )
        # fastapi-users 对停用用户直接拒绝登录
        assert login.status_code == 400


async def test_unknown_role_rejected(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await register_and_login(client)
    await set_role_in_db(migrated_pg, "luke@example.com", "admin")
    async with make_client(app) as admin:
        await admin.post("/auth/login", data={"username": "luke", "password": "password-123"})
        me = await admin.get("/users/me")
        response = await admin.patch(f"/users/{me.json()['user']['id']}", json={"role": "root"})
    assert response.status_code == 422
