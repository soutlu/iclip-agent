"""权限词汇表与预置角色：后端唯一事实源，前端只按 /users/me 的 permissions 做展示。

统一权限抽象：授权的唯一货币是权限集合（frozenset[str]）。
  用户有效权限   = 所分配角色的权限并集 ∪ 直接授权
  API key 有效权限 = key 显式授权集
角色只是权限集合的命名快捷方式（代码内预置，无角色管理表）。
权限是端点级能力门控，与行级归属（他人资源返 404）正交。
"""

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
# root 由全量计算而来：新增权限自动流入，不会漏。
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
