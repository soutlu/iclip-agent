"""用户管理面：分页信封、users:manage 门控、自我保护规则。"""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tests.integration_no_llm.conftest import (
    make_client,
    register_and_login,
    set_roles_in_db,
)


async def test_users_page_requires_manage_permission(
    client: httpx.AsyncClient,
) -> None:
    await register_and_login(client)
    assert (await client.get("/users")).status_code == 403


async def test_root_lists_users_with_page_envelope(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await register_and_login(client)
    await set_roles_in_db(migrated_pg, "luke@example.com", ["root"])

    async with make_client(app) as root:
        await root.post("/auth/login", data={"username": "luke", "password": "password-123"})
        page = await root.get("/users", params={"page": 1, "pageSize": 10})
    assert page.status_code == 200
    payload = page.json()
    assert payload["total"] == 1
    assert payload["page"] == 1
    assert payload["pageSize"] == 10
    item = payload["items"][0]
    assert item["roles"] == ["root"]
    assert item["directPermissions"] == []
    assert item["isActive"] is True
    assert "createdAt" in item


async def test_root_updates_roles_grants_and_self_protection(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    root_id = await register_and_login(client)
    await set_roles_in_db(migrated_pg, "luke@example.com", ["root"])

    async with make_client(app) as root:
        await root.post("/auth/login", data={"username": "luke", "password": "password-123"})
        other = await root.post(
            "/auth/register",
            json={
                "email": "member@example.com",
                "password": "password-123",
                "username": "member",
            },
        )
        other_id = other.json()["id"]

        promoted = await root.patch(f"/users/{other_id}", json={"roles": ["editor"]})
        assert promoted.status_code == 200
        assert promoted.json()["user"]["roles"] == ["editor"]

        granted = await root.patch(
            f"/users/{other_id}", json={"directPermissions": ["analytics:read"]}
        )
        assert granted.status_code == 200
        user = granted.json()["user"]
        assert user["directPermissions"] == ["analytics:read"]
        assert "analytics:read" in user["permissions"]

        assert (
            await root.patch(f"/users/{root_id}", json={"roles": ["viewer"]})
        ).status_code == 400
        assert (
            await root.patch(f"/users/{root_id}", json={"directPermissions": ["agent:run"]})
        ).status_code == 400
        assert (await root.patch(f"/users/{root_id}", json={"isActive": False})).status_code == 400

        deactivated = await root.patch(f"/users/{other_id}", json={"isActive": False})
        assert deactivated.status_code == 200
        assert deactivated.json()["user"]["isActive"] is False

    async with make_client(app) as member:
        login = await member.post(
            "/auth/login", data={"username": "member", "password": "password-123"}
        )
        assert login.status_code == 400


async def test_unknown_role_and_permission_rejected(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await register_and_login(client)
    await set_roles_in_db(migrated_pg, "luke@example.com", ["root"])
    async with make_client(app) as root:
        await root.post("/auth/login", data={"username": "luke", "password": "password-123"})
        other = await root.post(
            "/auth/register",
            json={"email": "x@example.com", "password": "password-123", "username": "x"},
        )
        other_id = other.json()["id"]
        assert (
            await root.patch(f"/users/{other_id}", json={"roles": ["admin"]})
        ).status_code == 422
        assert (
            await root.patch(f"/users/{other_id}", json={"directPermissions": ["root:all"]})
        ).status_code == 422


async def test_deactivation_kills_live_cookie_session(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    """停用应使现有 cookie 会话在下一次请求失效，无需等待 JWT 到期。"""

    await register_and_login(client)
    await set_roles_in_db(migrated_pg, "luke@example.com", ["root"])

    async with make_client(app) as root, make_client(app) as member:
        await root.post("/auth/login", data={"username": "luke", "password": "password-123"})
        created = await member.post(
            "/auth/register",
            json={"email": "m2@example.com", "password": "password-123", "username": "m2"},
        )
        member_id = created.json()["id"]
        await member.post("/auth/login", data={"username": "m2", "password": "password-123"})
        assert (await member.get("/users/me")).status_code == 200

        assert (
            await root.patch(f"/users/{member_id}", json={"isActive": False})
        ).status_code == 200
        assert (await member.get("/users/me")).status_code == 401
