"""SSO 登录链路：verify → PMS 资料 → 建号/关联 → 种 cookie。"""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from tests.integration_no_llm.conftest import make_client

SSO_OK = {
    "result": "OK",
    "userSession": {
        "innerUserId": 42,
        "unionId": "u-42",
        "name": "Luke W",
        "email": "luke@corp.test",
        "avatarUrl": "https://a/1.png",
    },
}

PMS_OK = {
    "success": True,
    "data": {
        "city": "杭州",
        "jobTitle": "策划",
        "depts": [
            {
                "id": 1,
                "uid": "d1",
                "name": "市场部",
                "parentId": None,
                "parentUid": "",
                "leaderUserId": None,
                "leaderUserUid": "",
                "source": "pms",
                "type": "dept",
                "order": 1,
            }
        ],
    },
}


def _json_transport(payload: object, status: int = 200) -> httpx.MockTransport:
    return httpx.MockTransport(lambda request: httpx.Response(status, json=payload))


@pytest.fixture
def sso_transport() -> httpx.MockTransport:
    return _json_transport(SSO_OK)


@pytest.fixture
def pms_transport() -> httpx.MockTransport | None:
    return _json_transport(PMS_OK)


async def test_authorize_exposes_issue_url(sso_app: FastAPI) -> None:
    async with make_client(sso_app) as client:
        response = await client.get("/auth/sso/authorize")
    assert response.status_code == 200
    url = response.json()["authorization_url"]
    assert url.startswith("https://sso.test/sso/issue/jwt?")
    assert "_fromApp=iclip" in url


async def test_first_login_creates_editor_with_pms_profile(sso_app: FastAPI) -> None:
    async with make_client(sso_app) as client:
        callback = await client.get("/auth/sso/callback", params={"jwt": "sso-jwt"})
        assert callback.status_code == 204, callback.text
        assert "iclip_session" in callback.headers.get("set-cookie", "")

        me = await client.get("/users/me")
    assert me.status_code == 200
    user = me.json()["user"]
    assert user["role"] == "editor"
    assert user["displayName"] == "Luke W"
    assert user["email"] == "luke@corp.test"
    assert user["city"] == "杭州"
    assert user["jobTitle"] == "策划"
    assert [d["name"] for d in user["departments"]] == ["市场部"]


async def test_second_login_reuses_account_and_keeps_role(
    sso_app: FastAPI, migrated_pg: str
) -> None:
    from tests.integration_no_llm.conftest import set_role_in_db

    async with make_client(sso_app) as client:
        assert (await client.get("/auth/sso/callback", params={"jwt": "j1"})).status_code == 204
    await set_role_in_db(migrated_pg, "luke@corp.test", "admin")

    async with make_client(sso_app) as client:
        assert (await client.get("/auth/sso/callback", params={"jwt": "j2"})).status_code == 204
        me = await client.get("/users/me")
    user = me.json()["user"]
    # 非首登不重置角色；同 unionId 命中同一账号
    assert user["role"] == "admin"


class TestFailurePaths:
    @pytest.fixture
    def sso_transport(self) -> httpx.MockTransport:
        return _json_transport({"result": "EXPIRED"})

    async def test_invalid_sso_session_is_401_without_cookie(self, sso_app: FastAPI) -> None:
        async with make_client(sso_app) as client:
            response = await client.get("/auth/sso/callback", params={"jwt": "bad"})
        assert response.status_code == 401
        assert "set-cookie" not in response.headers


class TestPmsFailureAborts:
    @pytest.fixture
    def sso_transport(self) -> httpx.MockTransport:
        return _json_transport(SSO_OK)

    @pytest.fixture
    def pms_transport(self) -> httpx.MockTransport | None:
        return _json_transport({"success": False, "responseDesc": "boom"})

    async def test_pms_failure_terminates_callback(self, sso_app: FastAPI) -> None:
        async with make_client(sso_app) as client:
            response = await client.get("/auth/sso/callback", params={"jwt": "j"})
            assert response.status_code == 502
            assert "set-cookie" not in response.headers
            # 没有半个账号被创建
            assert (await client.get("/users/me")).status_code == 401


async def test_sso_routes_absent_when_disabled(client: httpx.AsyncClient) -> None:
    assert (await client.get("/auth/sso/authorize")).status_code == 404
