"""角色 → 产品权限矩阵：后端唯一事实源，前端只按 /users/me 的 permissions 做展示。

单一权限词汇表（agent 面权限并入产品矩阵，不存在第二套 scope 空间）。
权限是端点级能力门控，与行级归属（他人资源返 404）正交。
"""

from __future__ import annotations

from iclip.domains.identity.models import Role

ROLES: tuple[Role, ...] = ("admin", "editor", "viewer")

PERMISSIONS: tuple[str, ...] = (
    "projects:read",
    "projects:write",
    "tasks:read",
    "tasks:write",
    "assets:read",
    "assets:write",
    "generation:read",
    "generation:submit",
    "analytics:read",
    "users:manage",
    "agent:read",
    "agent:run",
)

_VIEWER = frozenset(
    {
        "projects:read",
        "tasks:read",
        "assets:read",
        "generation:read",
        "agent:read",
    }
)
_EDITOR = frozenset(PERMISSIONS) - {"analytics:read", "users:manage"}
_ADMIN = frozenset(PERMISSIONS)

ROLE_PERMISSIONS: dict[Role, frozenset[str]] = {
    "admin": _ADMIN,
    "editor": _EDITOR,
    "viewer": _VIEWER,
}


def permissions_for(role: str) -> frozenset[str]:
    """返回角色的产品权限；未知角色无任何权限。"""

    return ROLE_PERMISSIONS.get(role, frozenset())  # type: ignore[arg-type]


def is_known_role(role: str) -> bool:
    return role in ROLE_PERMISSIONS


__all__ = ["PERMISSIONS", "ROLES", "ROLE_PERMISSIONS", "is_known_role", "permissions_for"]
