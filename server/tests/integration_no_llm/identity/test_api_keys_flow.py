"""API key 全链路：签发 → Bearer 调用 → 吊销 → 属主降权收缩。"""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tests.integration_no_llm.conftest import (
    make_client,
    register_and_login,
    set_role_in_db,
)


async def test_issue_bearer_call_and_revoke(app: FastAPI, client: httpx.AsyncClient) -> None:
    await register_and_login(client)

    created = await client.post(
        "/api-keys", json={"name": "ci", "permissions": ["projects:read", "agent:read"]}
    )
    assert created.status_code == 201, created.text
    payload = created.json()["apiKey"]
    token = payload["token"]
    assert token.startswith("iclip_sk_")
    assert payload["tokenPrefix"] == token[:16]

    # 明文只出现一次：列表面只有前缀
    listed = await client.get("/api-keys")
    assert listed.status_code == 200
    rows = listed.json()["apiKeys"]
    assert len(rows) == 1
    assert "token" not in rows[0]
    assert rows[0]["tokenPrefix"] == token[:16]

    # Bearer 调用：permissions 是 key 的授予集
    async with make_client(app) as machine:
        me = await machine.get("/users/me", headers={"Authorization": f"Bearer {token}"})
        assert me.status_code == 200
        assert set(me.json()["user"]["permissions"]) == {"projects:read", "agent:read"}

        revoked = await client.delete(f"/api-keys/{payload['id']}")
        assert revoked.status_code == 204

        after = await machine.get("/users/me", headers={"Authorization": f"Bearer {token}"})
        assert after.status_code == 401


async def test_key_grants_must_be_subset_of_owner(client: httpx.AsyncClient) -> None:
    await register_and_login(client)  # viewer
    denied = await client.post("/api-keys", json={"name": "esc", "permissions": ["projects:write"]})
    assert denied.status_code == 403

    unknown = await client.post("/api-keys", json={"name": "bad", "permissions": ["root:all"]})
    assert unknown.status_code == 422


async def test_owner_demotion_disarms_key_immediately(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await register_and_login(client)
    await set_role_in_db(migrated_pg, "luke@example.com", "admin")

    async with make_client(app) as admin:
        await admin.post("/auth/login", data={"username": "luke", "password": "password-123"})
        created = await admin.post(
            "/api-keys", json={"name": "ops", "permissions": ["users:manage"]}
        )
        token = created.json()["apiKey"]["token"]

    async with make_client(app) as machine:
        headers = {"Authorization": f"Bearer {token}"}
        assert (await machine.get("/users", headers=headers)).status_code == 200

        await set_role_in_db(migrated_pg, "luke@example.com", "viewer")
        # 属主降权即时生效：有效权限 = 授予集 ∩ 属主当下权限
        assert (await machine.get("/users", headers=headers)).status_code == 403


async def test_invalid_bearer_token_is_anonymous(client: httpx.AsyncClient) -> None:
    response = await client.get(
        "/users/me", headers={"Authorization": "Bearer iclip_sk_forged-token"}
    )
    assert response.status_code == 401
