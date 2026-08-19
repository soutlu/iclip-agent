"""API key 生命周期与主体构造的业务规则（内存仓储）。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from iclip.common.errors import (
    AuthenticationFailed,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from iclip.domains.identity.commands import CreateApiKey
from iclip.domains.identity.rbac import permissions_for
from iclip.domains.identity.service import (
    API_KEY_TOKEN_PREFIX,
    IdentityService,
    api_key_token_prefix,
    generate_api_key_token,
    hash_api_key_token,
)
from tests.helpers.identity import (
    InMemoryApiKeyRepository,
    InMemoryUserRepository,
    make_account,
)


def make_service(
    *accounts: object,
) -> tuple[IdentityService, InMemoryUserRepository, InMemoryApiKeyRepository]:
    users = InMemoryUserRepository(list(accounts))  # type: ignore[arg-type]
    api_keys = InMemoryApiKeyRepository()
    return IdentityService(users, api_keys), users, api_keys


def test_token_shape() -> None:
    token = generate_api_key_token()
    assert token.startswith(API_KEY_TOKEN_PREFIX)
    assert len(token) > 40
    assert len(hash_api_key_token(token)) == 64
    assert api_key_token_prefix(token) == token[:16]
    assert generate_api_key_token() != token


async def test_issue_and_authenticate_round_trip() -> None:
    owner = make_account(role="editor")
    service, _, _ = make_service(owner)
    principal = service.principal_for_user(owner)

    record, token = await service.issue_api_key(
        principal, CreateApiKey(name="ci", permissions=frozenset({"projects:read"}))
    )
    assert record.token_prefix == token[:16]

    key_principal = await service.authenticate_api_key(token)
    assert key_principal.kind == "api_key"
    assert key_principal.user_id == owner.id
    assert key_principal.api_key_id == record.id
    assert key_principal.permissions == {"projects:read"}


async def test_issue_rejects_permissions_beyond_owner() -> None:
    owner = make_account(role="viewer")
    service, _, _ = make_service(owner)
    principal = service.principal_for_user(owner)
    with pytest.raises(PermissionDenied):
        await service.issue_api_key(
            principal,
            CreateApiKey(name="k", permissions=frozenset({"projects:write"})),
        )


async def test_issue_rejects_unknown_permission_and_empty_grant() -> None:
    owner = make_account(role="admin")
    service, _, _ = make_service(owner)
    principal = service.principal_for_user(owner)
    with pytest.raises(ValidationFailed):
        await service.issue_api_key(
            principal, CreateApiKey(name="k", permissions=frozenset({"root:all"}))
        )
    with pytest.raises(ValidationFailed):
        await service.issue_api_key(principal, CreateApiKey(name="k", permissions=frozenset()))


async def test_api_key_principal_cannot_issue_keys() -> None:
    owner = make_account(role="admin")
    service, _, _ = make_service(owner)
    principal = service.principal_for_user(owner)
    _, token = await service.issue_api_key(
        principal, CreateApiKey(name="k", permissions=frozenset({"users:manage"}))
    )
    key_principal = await service.authenticate_api_key(token)
    with pytest.raises(PermissionDenied):
        await service.issue_api_key(
            key_principal, CreateApiKey(name="k2", permissions=frozenset({"agent:read"}))
        )


async def test_owner_demotion_shrinks_key_effective_permissions() -> None:
    owner = make_account(role="admin")
    service, users, _ = make_service(owner)
    principal = service.principal_for_user(owner)
    _, token = await service.issue_api_key(
        principal, CreateApiKey(name="k", permissions=frozenset({"users:manage"}))
    )
    await users.update_admin_fields(owner.id, role="viewer", is_active=None)

    key_principal = await service.authenticate_api_key(token)
    assert key_principal.permissions == frozenset()
    assert key_principal.permissions <= permissions_for("viewer")


async def test_revoked_expired_and_inactive_owner_all_fail_auth() -> None:
    owner = make_account(role="editor")
    service, users, api_keys = make_service(owner)
    principal = service.principal_for_user(owner)

    _, revoked_token = await service.issue_api_key(
        principal, CreateApiKey(name="a", permissions=frozenset({"projects:read"}))
    )
    record = (await api_keys.list_for_owner(owner.id))[0]
    await api_keys.revoke(record.id, datetime.now(UTC))
    with pytest.raises(AuthenticationFailed):
        await service.authenticate_api_key(revoked_token)

    _, expired_token = await service.issue_api_key(
        principal,
        CreateApiKey(
            name="b",
            permissions=frozenset({"projects:read"}),
            expires_at=datetime.now(UTC) + timedelta(seconds=1),
        ),
    )
    expired = next(r for r in (await api_keys.list_for_owner(owner.id)) if r.name == "b")
    from dataclasses import replace

    api_keys.records[expired.id] = replace(
        expired, expires_at=datetime.now(UTC) - timedelta(seconds=1)
    )
    with pytest.raises(AuthenticationFailed):
        await service.authenticate_api_key(expired_token)

    _, live_token = await service.issue_api_key(
        principal, CreateApiKey(name="c", permissions=frozenset({"projects:read"}))
    )
    await users.update_admin_fields(owner.id, role=None, is_active=False)
    with pytest.raises(AuthenticationFailed):
        await service.authenticate_api_key(live_token)


async def test_revoke_hides_others_keys_as_not_found() -> None:
    owner = make_account(role="editor")
    stranger = make_account(role="editor", username="mallory", email="m@example.com")
    service, _, api_keys = make_service(owner, stranger)
    principal = service.principal_for_user(owner)
    await service.issue_api_key(
        principal, CreateApiKey(name="k", permissions=frozenset({"projects:read"}))
    )
    record = (await api_keys.list_for_owner(owner.id))[0]

    with pytest.raises(NotFound):
        await service.revoke_api_key(service.principal_for_user(stranger), record.id)
    with pytest.raises(NotFound):
        await service.revoke_api_key(principal, uuid.uuid4())


def test_inactive_user_gets_no_principal() -> None:
    account = make_account(is_active=False)
    service, _, _ = make_service(account)
    with pytest.raises(AuthenticationFailed):
        service.principal_for_user(account)
