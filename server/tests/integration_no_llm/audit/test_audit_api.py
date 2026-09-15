"""审计端点：治理者才能看，参数错给 422，空库回全零的形状。"""

from __future__ import annotations

import httpx

from tests.integration_no_llm.conftest import register_and_login, set_roles_in_db

SUMMARY = "/audit/summary"
CONVERSATIONS = "/audit/conversations"
ANOMALIES = "/audit/anomalies"


async def login_as(client: httpx.AsyncClient, pg_url: str, role: str) -> None:
    email = f"{role}@example.com"
    await register_and_login(client, username=role, email=email)
    await set_roles_in_db(pg_url, email, [role])


async def test_anonymous_is_401(client: httpx.AsyncClient) -> None:
    for url in (SUMMARY, CONVERSATIONS, ANOMALIES):
        assert (await client.get(url)).status_code == 401


async def test_editor_is_403(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as(client, pg_url, "editor")

    for url in (SUMMARY, CONVERSATIONS, ANOMALIES):
        assert (await client.get(url)).status_code == 403


async def test_governor_reads_all_three_shapes(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as(client, pg_url, "root")

    summary = await client.get(SUMMARY, params={"bucket": "week", "timezone": "Asia/Shanghai"})
    conversations = await client.get(CONVERSATIONS)
    anomalies = await client.get(ANOMALIES, params=[("kind", "retry"), ("kind", "idle")])

    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["users"] == [] and body["tasks"] == [] and body["series"] == []
    overall = body["overall"]
    assert overall["deliveries"] == 0 and overall["attemptsPerShot"] is None
    assert overall["cycleSeconds"] is None
    assert overall["usage"]["totalTokens"] == 0 and overall["usage"]["cacheHitRate"] is None
    assert conversations.json() == {"items": [], "nextCursor": None}
    assert anomalies.json() == {"items": [], "nextCursor": None}


async def test_series_is_absent_without_bucket(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as(client, pg_url, "root")

    assert (await client.get(SUMMARY)).json()["series"] is None


async def test_bad_parameters_are_422(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as(client, pg_url, "root")

    inverted = await client.get(
        SUMMARY, params={"since": "2026-09-02T00:00:00Z", "until": "2026-09-01T00:00:00Z"}
    )
    bad_zone = await client.get(SUMMARY, params={"bucket": "day", "timezone": "Mars/Olympus"})
    bad_cursor = await client.get(CONVERSATIONS, params={"cursor": "not-a-cursor"})
    bad_kind = await client.get(ANOMALIES, params={"kind": "nonsense"})
    bad_threshold = await client.get(ANOMALIES, params={"retryOver": 0})

    assert inverted.status_code == 422 and "since" in inverted.json()["detail"]
    assert bad_zone.status_code == 422 and "timezone" in bad_zone.json()["detail"]
    assert bad_cursor.status_code == 422 and "cursor" in bad_cursor.json()["detail"]
    assert bad_kind.status_code == 422
    assert bad_threshold.status_code == 422
