"""端点权限声明：权限名在声明时校验，全部持有才放行，拒绝时点名缺的每一项。"""

from __future__ import annotations

import uuid
from typing import Annotated

import pytest
from fastapi import APIRouter

from iclip.domains.identity.public import Principal, require_permission
from tests.helpers.app import app_with_principal, make_client

GUARDED = "/guarded"


def principal(*permissions: str) -> Principal:
    return Principal(
        kind="user", user_id=uuid.uuid4(), permissions=frozenset(permissions), audit_label="t"
    )


def guarded_router() -> APIRouter:
    router = APIRouter()

    @router.get(GUARDED)
    async def guarded(
        _: Annotated[Principal, require_permission("agent:read", "users:manage")],
    ) -> dict[str, bool]:
        return {"ok": True}

    return router


async def status_and_detail(granted: Principal | None) -> tuple[int, str]:
    app = app_with_principal(granted)
    app.include_router(guarded_router())
    async with make_client(app) as http:
        response = await http.get(GUARDED)
    return response.status_code, str(response.json().get("detail", ""))


def test_unknown_or_absent_permission_fails_at_declaration() -> None:
    with pytest.raises(ValueError, match="agent:reed"):
        require_permission("agent:read", "agent:reed")
    with pytest.raises(ValueError):
        require_permission()


async def test_every_declared_permission_is_required() -> None:
    assert (await status_and_detail(principal("agent:read", "users:manage")))[0] == 200
    assert (await status_and_detail(None))[0] == 401

    status, detail = await status_and_detail(principal("tasks:read"))
    assert status == 403
    assert "agent:read" in detail and "users:manage" in detail

    status, detail = await status_and_detail(principal("agent:read"))
    assert status == 403
    assert "users:manage" in detail and "agent:read" not in detail
