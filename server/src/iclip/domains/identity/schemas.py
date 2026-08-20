"""identity wire 模型（camelCase）。"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from iclip.domains.identity.models import ApiKeyRecord, PmsDepartment, Principal, UserAccount
from iclip.domains.identity.rbac import effective_permissions


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class DepartmentOut(CamelModel):
    id: int
    uid: str
    name: str
    parent_id: int | None
    parent_uid: str
    leader_user_id: int | None
    leader_user_uid: str
    source: str
    type: str
    order: int | None


class UserOut(CamelModel):
    id: uuid.UUID
    email: str
    username: str | None
    display_name: str
    avatar_url: str
    roles: list[str]
    direct_permissions: list[str]
    permissions: list[str]
    is_active: bool
    city: str
    job_title: str
    departments: list[DepartmentOut]
    created_at: datetime | None
    last_login_at: datetime | None


class UserEnvelope(CamelModel):
    user: UserOut


class UsersPageOut(CamelModel):
    items: list[UserOut]
    total: int
    page: int
    page_size: int


class UserPatchIn(CamelModel):
    roles: list[str] | None = None
    direct_permissions: list[str] | None = None
    is_active: bool | None = None


class ApiKeyCreateIn(CamelModel):
    name: str
    permissions: list[str]
    expires_at: datetime | None = None


class ApiKeyOut(CamelModel):
    id: uuid.UUID
    name: str
    token_prefix: str
    permissions: list[str]
    expires_at: datetime | None
    revoked_at: datetime | None
    last_used_at: datetime | None
    created_at: datetime | None


class ApiKeyCreatedOut(ApiKeyOut):
    token: str


class ApiKeyCreatedEnvelope(CamelModel):
    """创建响应专用信封——含一次性明文 token。"""

    api_key: ApiKeyCreatedOut


class ApiKeysEnvelope(CamelModel):
    api_keys: list[ApiKeyOut]


class SsoAuthorizeOut(BaseModel):
    # 历史契约字段为 snake_case（前端 zod 锁定），是 camelCase 约定的显式例外。
    authorization_url: str


def _department_out(dept: PmsDepartment) -> DepartmentOut:
    return DepartmentOut(
        id=dept.id,
        uid=dept.uid,
        name=dept.name,
        parent_id=dept.parent_id,
        parent_uid=dept.parent_uid,
        leader_user_id=dept.leader_user_id,
        leader_user_uid=dept.leader_user_uid,
        source=dept.source,
        type=dept.type,
        order=dept.order,
    )


def user_out(account: UserAccount, *, permissions: frozenset[str] | None = None) -> UserOut:
    """用户视图；``permissions`` 缺省为账号有效权限（角色并集 ∪ 直接授权）。"""

    if permissions is None:
        permissions = effective_permissions(account.roles, account.direct_permissions)
    return UserOut(
        id=account.id,
        email=account.email,
        username=account.username,
        display_name=account.display_name,
        avatar_url=account.avatar_url,
        roles=list(account.roles),
        direct_permissions=sorted(account.direct_permissions),
        permissions=sorted(permissions),
        is_active=account.is_active,
        city=account.city,
        job_title=account.job_title,
        departments=[_department_out(d) for d in account.departments],
        created_at=account.created_at,
        last_login_at=account.last_login_at,
    )


def user_out_for_principal(account: UserAccount, principal: Principal) -> UserOut:
    """``/users/me`` 专用：权限取主体生效集（API key 场景为 key 显式授权集）。"""

    return user_out(account, permissions=principal.permissions)


def api_key_out(record: ApiKeyRecord) -> ApiKeyOut:
    return ApiKeyOut(
        id=record.id,
        name=record.name,
        token_prefix=record.token_prefix,
        permissions=sorted(record.permissions),
        expires_at=record.expires_at,
        revoked_at=record.revoked_at,
        last_used_at=record.last_used_at,
        created_at=record.created_at,
    )


__all__ = [
    "ApiKeyCreateIn",
    "ApiKeyCreatedEnvelope",
    "ApiKeyCreatedOut",
    "ApiKeyOut",
    "ApiKeysEnvelope",
    "CamelModel",
    "DepartmentOut",
    "SsoAuthorizeOut",
    "UserEnvelope",
    "UserOut",
    "UserPatchIn",
    "UsersPageOut",
    "api_key_out",
    "user_out",
    "user_out_for_principal",
]
