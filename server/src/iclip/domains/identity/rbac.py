"""权限与预置角色的唯一事实源，前端依据 /users/me 的权限集展示。

用户权限为角色权限并集加直接授权；API key 权限仅为显式授权集。
端点权限与行级归属独立判断。"""

from __future__ import annotations

from collections.abc import Iterable

PERMISSIONS: tuple[str, ...] = (
    "collections:read",
    "collections:write",
    "tasks:read",
    "tasks:write",
    "assets:read",
    "assets:write",
    "generation:read",
    "generation:submit",
    "analytics:read",
    "users:manage",
    "api_keys:issue",
    "agent:read",
    "agent:run",
)

_VIEWER = frozenset(
    {
        "collections:read",
        "tasks:read",
        "assets:read",
        "generation:read",
        "agent:read",
    }
)
_EDITOR = frozenset(PERMISSIONS) - {"analytics:read", "users:manage", "api_keys:issue"}
_ROOT = frozenset(PERMISSIONS)

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "root": _ROOT,
    "editor": _EDITOR,
    "viewer": _VIEWER,
}

ROLES: tuple[str, ...] = tuple(ROLE_PERMISSIONS)

ROOT_ROLE = "root"


def effective_permissions(
    roles: Iterable[str], direct_permissions: Iterable[str] = ()
) -> frozenset[str]:
    """角色权限并集 ∪ 直接授权；未知角色贡献空集。"""

    granted = frozenset(direct_permissions)
    for role in roles:
        granted |= ROLE_PERMISSIONS.get(role, frozenset())
    return granted


def is_known_role(role: str) -> bool:
    return role in ROLE_PERMISSIONS


__all__ = [
    "PERMISSIONS",
    "ROLES",
    "ROLE_PERMISSIONS",
    "ROOT_ROLE",
    "effective_permissions",
    "is_known_role",
]
