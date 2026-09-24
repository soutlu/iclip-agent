"""经 HTTP 注册登录，以及测试内直接写库授角色。"""

from __future__ import annotations

import json

import httpx
from sqlalchemy import text

from tests.helpers.pg import connected


async def register_and_login(
    client: httpx.AsyncClient,
    *,
    username: str = "luke",
    email: str = "luke@example.com",
    password: str = "password-123",
) -> str:
    """注册 + 登录；返回用户 id。"""

    created = await client.post(
        "/auth/register",
        json={"email": email, "password": password, "username": username},
    )
    assert created.status_code == 201, created.text
    logged_in = await client.post("/auth/login", data={"username": username, "password": password})
    assert logged_in.status_code == 204, logged_in.text
    return str(created.json()["id"])


async def set_roles_in_db(pg_url: str, email: str, roles: list[str]) -> None:
    """测试内的角色引导（生产路径是 ROOT_EMAIL / scripts/admin.py）。"""

    async with connected(pg_url) as conn:
        await conn.execute(
            text("UPDATE iclip.users SET roles = CAST(:roles AS jsonb) WHERE email = :email"),
            {"roles": json.dumps(roles), "email": email},
        )


async def login_as_editor(client: httpx.AsyncClient, pg_url: str, *, username: str = "luke") -> str:
    """以 ``{username}@example.com`` 注册登录并授 editor 角色；返回用户 id。"""

    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email)
    await set_roles_in_db(pg_url, email, ["editor"])
    return user_id


__all__ = ["login_as_editor", "register_and_login", "set_roles_in_db"]
