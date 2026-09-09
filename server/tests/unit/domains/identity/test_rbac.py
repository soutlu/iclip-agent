"""权限词汇表与预置角色的不变量。"""

from __future__ import annotations

from iclip.domains.identity.rbac import (
    PERMISSIONS,
    ROLE_PERMISSIONS,
    ROOT_ROLE,
    effective_permissions,
)


def test_role_hierarchy_is_strictly_nested() -> None:
    viewer, editor, root = (
        ROLE_PERMISSIONS["viewer"],
        ROLE_PERMISSIONS["editor"],
        ROLE_PERMISSIONS["root"],
    )
    assert viewer < editor < root
    # root 由全量计算而来：新增权限自动流入
    assert root == frozenset(PERMISSIONS)


def test_editor_lacks_exactly_root_only_permissions() -> None:
    assert frozenset(PERMISSIONS) - ROLE_PERMISSIONS["editor"] == {
        "analytics:read",
        "users:manage",
        "api_keys:issue",
    }


def test_viewer_is_read_only_plus_agent_read() -> None:
    assert ROLE_PERMISSIONS["viewer"] == {
        "collections:read",
        "tasks:read",
        "assets:read",
        "generation:read",
        "agent:read",
    }


def test_effective_permissions_is_role_union_plus_direct_grants() -> None:
    assert effective_permissions(("viewer",), {"generation:submit"}) == (
        ROLE_PERMISSIONS["viewer"] | {"generation:submit"}
    )
    assert effective_permissions(("viewer", "editor")) == ROLE_PERMISSIONS["editor"]


def test_unknown_role_contributes_nothing() -> None:
    assert effective_permissions(("admin",)) == frozenset()
    assert effective_permissions((), ()) == frozenset()


def test_only_root_can_issue_api_keys() -> None:
    holders = [name for name, perms in ROLE_PERMISSIONS.items() if "api_keys:issue" in perms]
    assert holders == [ROOT_ROLE]
