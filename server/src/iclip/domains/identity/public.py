"""identity 的跨模块契约：其它模块只准从这里 import。"""

from __future__ import annotations

from iclip.domains.identity.middleware import (
    require_authenticated,
    require_permission,
    websocket_origin_allowed,
    websocket_principal,
)
from iclip.domains.identity.models import Principal, UserAccount
from iclip.domains.identity.rbac import PERMISSIONS, ROLES, effective_permissions
from iclip.domains.identity.user_name import resolve_user_name

__all__ = [
    "PERMISSIONS",
    "ROLES",
    "Principal",
    "UserAccount",
    "effective_permissions",
    "require_authenticated",
    "require_permission",
    "resolve_user_name",
    "websocket_origin_allowed",
    "websocket_principal",
]
