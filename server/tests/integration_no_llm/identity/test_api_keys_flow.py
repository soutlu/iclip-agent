"""API key 全链路：root 签发 → Bearer 调用 → 吊销；key 权限即显式授权集。"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI

from tests.integration_no_llm.conftest import (
    make_client,
    register_and_login,
    set_roles_in_db,
)


@asynccontextmanager
async def _root_client(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> AsyncGenerator[httpx.AsyncClient]:
    await register_and_login(client)
    await set_roles_in_db(pg_url, "luke@example.com", ["root"])
    async with make_client(app) as root:
        await root.post("/auth/login", data={"username": "luke", "password": "password-123"})
        yield root


async def test_issue_bearer_call_and_revoke(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    async with _root_client(app, client, migrated_pg) as root:
        created = await root.post(
            "/api-keys", json={"name": "ci", "permissions": ["collections:read", "agent:read"]}
        )
        assert created.status_code == 201, created.text
        payload = created.json()["apiKey"]
        token = payload["token"]
        assert token.startswith("iclip_sk_")
        assert payload["tokenPrefix"] == token[:16]

        # 明文只出现一次：列表面只有前缀
        listed = await root.get("/api-keys")
        assert listed.status_code == 200
        rows = listed.json()["apiKeys"]
        assert len(rows) == 1
        assert "token" not in rows[0]
        assert rows[0]["tokenPrefix"] == token[:16]

        # Bearer 调用：permissions 是 key 的显式授权集
        async with make_client(app) as machine:
            me = await machine.get("/users/me", headers={"Authorization": f"Bearer {token}"})
            assert me.status_code == 200
            assert set(me.json()["user"]["permissions"]) == {"collections:read", "agent:read"}

            revoked = await root.delete(f"/api-keys/{payload['id']}")
            assert revoked.status_code == 204

            after = await machine.get("/users/me", headers={"Authorization": f"Bearer {token}"})
            assert after.status_code == 401


async def test_non_root_cannot_issue_keys(client: httpx.AsyncClient) -> None:
    await register_and_login(client)  # 密码注册默认 viewer，无 api_keys:issue
    denied = await client.post("/api-keys", json={"name": "k", "permissions": ["collections:read"]})
    assert denied.status_code == 403


async def test_unknown_permission_rejected(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    async with _root_client(app, client, migrated_pg) as root:
        unknown = await root.post("/api-keys", json={"name": "bad", "permissions": ["root:all"]})
        assert unknown.status_code == 422


async def test_key_permissions_survive_owner_role_change(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    async with _root_client(app, client, migrated_pg) as root:
        created = await root.post(
            "/api-keys", json={"name": "ops", "permissions": ["users:manage"]}
        )
        token = created.json()["apiKey"]["token"]

    async with make_client(app) as machine:
        headers = {"Authorization": f"Bearer {token}"}
        assert (await machine.get("/users", headers=headers)).status_code == 200

        await set_roles_in_db(migrated_pg, "luke@example.com", ["viewer"])
        # key 有效权限 = 显式授权集，不随属主角色变化
        assert (await machine.get("/users", headers=headers)).status_code == 200


async def test_invalid_bearer_token_is_anonymous(client: httpx.AsyncClient) -> None:
    response = await client.get(
        "/users/me", headers={"Authorization": "Bearer iclip_sk_forged-token"}
    )
    assert response.status_code == 401
