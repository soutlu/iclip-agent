"""cookie 会话链路：注册 → 登录 → /users/me → 登出。"""

from __future__ import annotations

import httpx

from tests.integration_no_llm.conftest import register_and_login


async def test_register_login_me_logout_round_trip(client: httpx.AsyncClient) -> None:
    user_id = await register_and_login(client)

    me = await client.get("/users/me")
    assert me.status_code == 200
    user = me.json()["user"]
    assert user["id"] == user_id
    assert user["username"] == "luke"
    assert user["roles"] == ["viewer"]
    assert user["directPermissions"] == []
    assert set(user["permissions"]) == {
        "collections:read",
        "tasks:read",
        "assets:read",
        "generation:read",
        "agent:read",
    }
    # camelCase wire：不出现 snake_case 键
    assert "displayName" in user and "display_name" not in user
    assert user["departments"] == []

    assert (await client.post("/auth/logout")).status_code == 204
    assert (await client.get("/users/me")).status_code == 401


async def test_login_with_email_identifier(client: httpx.AsyncClient) -> None:
    await register_and_login(client)
    await client.post("/auth/logout")
    ok = await client.post(
        "/auth/login",
        data={"username": "luke@example.com", "password": "password-123"},
    )
    assert ok.status_code == 204
    assert (await client.get("/users/me")).status_code == 200


async def test_wrong_password_rejected_without_cookie(client: httpx.AsyncClient) -> None:
    await client.post(
        "/auth/register",
        json={"email": "a@example.com", "password": "password-123", "username": "a"},
    )
    bad = await client.post("/auth/login", data={"username": "a", "password": "nope-nope"})
    assert bad.status_code == 400
    assert (await client.get("/users/me")).status_code == 401


async def test_short_password_rejected_at_register(client: httpx.AsyncClient) -> None:
    bad = await client.post(
        "/auth/register",
        json={"email": "b@example.com", "password": "short", "username": "b"},
    )
    assert bad.status_code == 400


async def test_duplicate_username_rejected(client: httpx.AsyncClient) -> None:
    await register_and_login(client)
    dup = await client.post(
        "/auth/register",
        json={"email": "other@example.com", "password": "password-123", "username": "luke"},
    )
    assert dup.status_code == 400


async def test_anonymous_me_is_401(client: httpx.AsyncClient) -> None:
    assert (await client.get("/users/me")).status_code == 401


async def test_healthz_is_public(client: httpx.AsyncClient) -> None:
    response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
