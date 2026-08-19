"""identity wire 模型（camelCase）。"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from iclip.domains.identity.models import ApiKeyRecord, PmsDepartment, Principal, UserAccount


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
    role: str
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
    role: str | None = None
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


class ApiKeyEnvelope(CamelModel):
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


def user_out(account: UserAccount, *, permissions: frozenset[str]) -> UserOut:
    return UserOut(
        id=account.id,
        email=account.email,
        username=account.username,
        display_name=account.display_name,
        avatar_url=account.avatar_url,
        role=account.role,
        permissions=sorted(permissions),
        is_active=account.is_active,
        city=account.city,
        job_title=account.job_title,
        departments=[_department_out(d) for d in account.departments],
        created_at=account.created_at,
        last_login_at=account.last_login_at,
    )


def user_out_for_principal(account: UserAccount, principal: Principal) -> UserOut:
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
    "ApiKeyCreatedOut",
    "ApiKeyEnvelope",
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
