"""角色矩阵不变量。"""

from __future__ import annotations

from iclip.domains.identity.rbac import PERMISSIONS, ROLE_PERMISSIONS, permissions_for


def test_role_hierarchy_is_strictly_nested() -> None:
    viewer, editor, admin = (
        ROLE_PERMISSIONS["viewer"],
        ROLE_PERMISSIONS["editor"],
        ROLE_PERMISSIONS["admin"],
    )
    assert viewer < editor < admin
    assert admin == frozenset(PERMISSIONS)


def test_editor_lacks_exactly_admin_only_permissions() -> None:
    assert frozenset(PERMISSIONS) - ROLE_PERMISSIONS["editor"] == {
        "analytics:read",
        "users:manage",
    }


def test_viewer_is_read_only_plus_agent_read() -> None:
    assert ROLE_PERMISSIONS["viewer"] == {
        "projects:read",
        "tasks:read",
        "assets:read",
        "generation:read",
        "agent:read",
    }


def test_unknown_role_has_no_permissions() -> None:
    assert permissions_for("root") == frozenset()
    assert permissions_for("") == frozenset()
