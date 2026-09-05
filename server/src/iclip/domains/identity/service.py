"""identity 业务规则：Principal 构造、API key 生命周期、用户管理。

出站只经 repository Protocol；不 import 框架。
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime

from iclip.common.errors import (
    AuthenticationFailed,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from iclip.domains.identity.commands import CreateApiKey, UpdateUser
from iclip.domains.identity.models import ApiKeyRecord, Principal, UserAccount
from iclip.domains.identity.rbac import PERMISSIONS, effective_permissions, is_known_role
from iclip.domains.identity.repository import ApiKeyRepository, UserRepository

API_KEY_TOKEN_PREFIX = "iclip_sk_"
_TOKEN_PREFIX_DISPLAY_LENGTH = 16
_MAX_KEY_NAME_LENGTH = 200


class SelfManagementForbidden(ValidationFailed):
    """用户管理者不能修改自己的授权或停用自己（wire 层映射 400）。"""


def generate_api_key_token() -> str:
    return f"{API_KEY_TOKEN_PREFIX}{secrets.token_urlsafe(32)}"


def hash_api_key_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def api_key_token_prefix(token: str) -> str:
    return token[:_TOKEN_PREFIX_DISPLAY_LENGTH]


def _now() -> datetime:
    return datetime.now(UTC)


class IdentityService:
    def __init__(self, users: UserRepository, api_keys: ApiKeyRepository) -> None:
        self._users = users
        self._api_keys = api_keys

    def principal_for_user(self, account: UserAccount) -> Principal:
        if not account.is_active:
            raise AuthenticationFailed("账号已停用")
        return Principal(
            kind="user",
            user_id=account.id,
            permissions=effective_permissions(account.roles, account.direct_permissions),
            audit_label=account.username or account.email,
        )

    async def authenticate_api_key(self, token: str) -> Principal:
        """校验 Bearer API key 并构造主体；任何一步不满足都判定凭证无效。

        有效权限 = key 显式授权集；属主停用/吊销/过期即失效。
        """

        if not token.startswith(API_KEY_TOKEN_PREFIX):
            raise AuthenticationFailed("API key 无效")
        record = await self._api_keys.get_by_hash(hash_api_key_token(token))
        if record is None or record.revoked_at is not None:
            raise AuthenticationFailed("API key 无效")
        now = _now()
        if record.expires_at is not None and record.expires_at <= now:
            raise AuthenticationFailed("API key 已过期")
        owner = await self._users.get(record.owner_user_id)
        if owner is None or not owner.is_active:
            raise AuthenticationFailed("API key 属主不可用")
        await self._api_keys.touch_last_used(record.id, now)
        return Principal(
            kind="api_key",
            user_id=owner.id,
            api_key_id=record.id,
            permissions=record.permissions,
            audit_label=f"{owner.username or owner.email}#{record.name}",
        )

    async def get_account(self, user_id: uuid.UUID) -> UserAccount:
        account = await self._users.get(user_id)
        if account is None:
            raise NotFound("用户不存在")
        return account

    async def issue_api_key(
        self, principal: Principal, command: CreateApiKey
    ) -> tuple[ApiKeyRecord, str]:
        """签发 key；明文只在返回值出现一次。"""

        if principal.kind != "user":
            raise PermissionDenied("API key 不能签发新的 API key")
        if not principal.has("api_keys:issue"):
            raise PermissionDenied("需要 api_keys:issue 权限")
        name = command.name.strip()
        if not name or len(name) > _MAX_KEY_NAME_LENGTH:
            raise ValidationFailed(f"key 名称必须非空且不超过 {_MAX_KEY_NAME_LENGTH} 字符")
        if not command.permissions:
            raise ValidationFailed("key 至少授予一项权限")
        unknown = command.permissions - set(PERMISSIONS)
        if unknown:
            raise ValidationFailed(f"未知权限: {', '.join(sorted(unknown))}")
        if not command.permissions <= principal.permissions:
            raise PermissionDenied("key 权限不能超出属主当前权限")
        if command.expires_at is not None and command.expires_at <= _now():
            raise ValidationFailed("过期时间必须在未来")

        token = generate_api_key_token()
        record = ApiKeyRecord(
            id=uuid.uuid4(),
            owner_user_id=principal.user_id,
            name=name,
            token_prefix=api_key_token_prefix(token),
            permissions=frozenset(command.permissions),
            expires_at=command.expires_at,
            revoked_at=None,
            last_used_at=None,
            created_at=None,
        )
        await self._api_keys.add(record, token_hash=hash_api_key_token(token))
        return record, token

    async def list_api_keys(self, principal: Principal) -> tuple[ApiKeyRecord, ...]:
        owner = None if principal.has("users:manage") else principal.user_id
        return await self._api_keys.list_for_owner(owner)

    async def revoke_api_key(self, principal: Principal, key_id: uuid.UUID) -> None:
        record = await self._api_keys.get(key_id)
        if record is None:
            raise NotFound("API key 不存在")
        if record.owner_user_id != principal.user_id and not principal.has("users:manage"):
            raise NotFound("API key 不存在")
        await self._api_keys.revoke(key_id, _now())

    async def list_users_page(
        self, principal: Principal, *, page: int, page_size: int
    ) -> tuple[tuple[UserAccount, ...], int]:
        if not principal.has("users:manage"):
            raise PermissionDenied("需要 users:manage 权限")
        if page < 1 or page_size < 1 or page_size > 200:
            raise ValidationFailed("分页参数无效")
        return await self._users.list_page(offset=(page - 1) * page_size, limit=page_size)

    async def update_user(
        self, principal: Principal, user_id: uuid.UUID, patch: UpdateUser
    ) -> UserAccount:
        if not principal.has("users:manage"):
            raise PermissionDenied("需要 users:manage 权限")
        if patch.roles is not None:
            unknown_roles = {role for role in patch.roles if not is_known_role(role)}
            if unknown_roles:
                raise ValidationFailed(f"未知角色: {', '.join(sorted(unknown_roles))}")
        if patch.direct_permissions is not None:
            unknown = patch.direct_permissions - set(PERMISSIONS)
            if unknown:
                raise ValidationFailed(f"未知权限: {', '.join(sorted(unknown))}")
        if user_id == principal.user_id:
            if patch.roles is not None or patch.direct_permissions is not None:
                raise SelfManagementForbidden("不能修改自己的授权")
            if patch.is_active is False:
                raise SelfManagementForbidden("不能停用自己")
        updated = await self._users.update_access_fields(
            user_id,
            roles=patch.roles,
            direct_permissions=patch.direct_permissions,
            is_active=patch.is_active,
        )
        if updated is None:
            raise NotFound("用户不存在")
        return updated


__all__ = [
    "API_KEY_TOKEN_PREFIX",
    "IdentityService",
    "SelfManagementForbidden",
    "api_key_token_prefix",
    "generate_api_key_token",
    "hash_api_key_token",
]
