"""identity 纯领域对象：账号快照、API key、Principal。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

Role = Literal["admin", "editor", "viewer"]
PrincipalKind = Literal["user", "api_key"]


@dataclass(frozen=True, slots=True)
class PmsDepartment:
    """PMS 返回的部门条目（SSO 登录时快照进用户行）。"""

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


@dataclass(frozen=True, slots=True)
class UserAccount:
    """用户账号的不可变快照。"""

    id: uuid.UUID
    email: str
    username: str | None
    display_name: str
    avatar_url: str
    role: str
    is_active: bool
    city: str
    job_title: str
    departments: tuple[PmsDepartment, ...]
    created_at: datetime | None
    last_login_at: datetime | None


@dataclass(frozen=True, slots=True)
class ApiKeyRecord:
    """API key 元数据；token 明文不落库，只存哈希与展示前缀。"""

    id: uuid.UUID
    owner_user_id: uuid.UUID
    name: str
    token_prefix: str
    permissions: frozenset[str]
    expires_at: datetime | None
    revoked_at: datetime | None
    last_used_at: datetime | None
    created_at: datetime | None


@dataclass(frozen=True, slots=True)
class Principal:
    """唯一可信调用主体；下游一切授权与审计只消费本对象。

    ``kind == "api_key"`` 时 ``permissions`` 已是 key 授予集与属主当下
    角色权限的交集。
    """

    kind: PrincipalKind
    user_id: uuid.UUID
    permissions: frozenset[str]
    display: str
    api_key_id: uuid.UUID | None = field(default=None)

    def has(self, permission: str) -> bool:
        return permission in self.permissions


__all__ = [
    "ApiKeyRecord",
    "PmsDepartment",
    "Principal",
    "PrincipalKind",
    "Role",
    "UserAccount",
]
