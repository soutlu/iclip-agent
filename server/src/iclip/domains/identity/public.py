"""identity 的跨模块契约：其它模块只准从这里 import。"""

from __future__ import annotations

from iclip.domains.identity.middleware import (
    require_authenticated,
    require_permission,
    websocket_origin_allowed,
    websocket_principal,
)
from iclip.domains.identity.models import Principal, Role, UserAccount
from iclip.domains.identity.rbac import PERMISSIONS, ROLES, permissions_for

__all__ = [
    "PERMISSIONS",
    "ROLES",
    "Principal",
    "Role",
    "UserAccount",
    "permissions_for",
    "require_authenticated",
    "require_permission",
    "websocket_origin_allowed",
    "websocket_principal",
]
