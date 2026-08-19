"""SSO / PMS 协议客户端的解析契约（httpx MockTransport）。"""

from __future__ import annotations

import json

import httpx
import pytest

from iclip.domains.identity.pms import PmsUnavailable, PmsUserClient
from iclip.domains.identity.sso import (
    SsoSessionInvalid,
    SsoUnavailable,
    SsoVerifier,
    sso_placeholder_email,
)


def make_verifier(handler: httpx.MockTransport) -> SsoVerifier:
    return SsoVerifier(
        base_url="https://sso.test",
        app_name="iclip",
        redirect_url="https://app.test/auth/sso/landing",
        transport=handler,
    )


def json_transport(payload: object, status: int = 200) -> httpx.MockTransport:
    return httpx.MockTransport(lambda request: httpx.Response(status, json=payload))


def test_authorization_url_carries_redirect_and_app() -> None:
    verifier = make_verifier(json_transport({}))
    url = verifier.authorization_url()
    assert url.startswith("https://sso.test/sso/issue/jwt?")
    assert "redirect_uri=https%3A%2F%2Fapp.test%2Fauth%2Fsso%2Flanding" in url
    assert "_fromApp=iclip" in url


async def test_verify_parses_user_session() -> None:
    payload = {
        "result": "OK",
        "userSession": {
            "innerUserId": 42,
            "unionId": "u-42",
            "name": "Luke",
            "email": "luke@corp.test",
            "avatarUrl": "https://a/1.png",
        },
    }
    session = await make_verifier(json_transport(payload)).verify("jwt-token")
    assert session.inner_user_id == 42
    assert session.union_id == "u-42"
    assert session.name == "Luke"


async def test_verify_rejects_invalid_session() -> None:
    with pytest.raises(SsoSessionInvalid):
        await make_verifier(json_transport({"result": "EXPIRED"})).verify("t")


@pytest.mark.parametrize(
    "user_session",
    [
        {"unionId": "u-1"},
        {"innerUserId": 0, "unionId": "u-1"},
        {"innerUserId": True, "unionId": "u-1"},
        {"innerUserId": 7, "unionId": "  "},
    ],
)
async def test_verify_rejects_malformed_user_session(user_session: dict[str, object]) -> None:
    payload = {"result": "OK", "userSession": user_session}
    with pytest.raises(SsoUnavailable):
        await make_verifier(json_transport(payload)).verify("t")


async def test_verify_network_error_maps_to_unavailable() -> None:
    def raise_error(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    with pytest.raises(SsoUnavailable):
        await make_verifier(httpx.MockTransport(raise_error)).verify("t")


def test_placeholder_email_is_deterministic() -> None:
    assert sso_placeholder_email("u-1") == "u-1@sso.iclip.example"


async def test_pms_parses_profile_and_departments() -> None:
    payload = {
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
                    "leaderUserId": 9,
                    "leaderUserUid": "u9",
                    "source": "pms",
                    "type": "dept",
                    "order": 2,
                }
            ],
        },
    }
    client = PmsUserClient(base_url="https://pms.test", transport=json_transport(payload))
    profile = await client.get_user(inner_user_id=42, authorization="jwt")
    assert profile.city == "杭州"
    assert profile.departments[0].name == "市场部"
    assert profile.departments[0].leader_user_id == 9


async def test_pms_failure_shapes() -> None:
    failure = PmsUserClient(
        base_url="https://pms.test",
        transport=json_transport({"success": False, "responseDesc": "no user"}),
    )
    with pytest.raises(PmsUnavailable, match="no user"):
        await failure.get_user(inner_user_id=1, authorization="jwt")

    bad_depts = PmsUserClient(
        base_url="https://pms.test",
        transport=json_transport({"success": True, "data": {"depts": ["oops"]}}),
    )
    with pytest.raises(PmsUnavailable):
        await bad_depts.get_user(inner_user_id=1, authorization="jwt")


async def test_pms_sends_authorization_header() -> None:
    seen: dict[str, str] = {}

    def capture(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization", "")
        seen["path"] = request.url.path
        return httpx.Response(200, text=json.dumps({"success": True, "data": {}}))

    client = PmsUserClient(base_url="https://pms.test", transport=httpx.MockTransport(capture))
    await client.get_user(inner_user_id=42, authorization="sso-jwt")
    assert seen["auth"] == "sso-jwt"
    assert seen["path"] == "/pms-console/user/selectUserById/42"
