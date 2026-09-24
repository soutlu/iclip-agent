"""Principal 解析：唯一可信身份建立点，传输无关（HTTP / WebSocket 握手）。

每 hop 只解析一次：cookie 会话 JWT 验签一次 + 活跃用户加载一次，或
Bearer API key 哈希查表一次。任何一步失败即匿名（None），受保护路由 401。
端点权限由路由用 ``require_authenticated`` / ``require_permission`` 声明，同一份声明导出到合同的
操作级 ``security``。
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Annotated, Any
from urllib.parse import urlsplit

import structlog
from fastapi import Depends, HTTPException, Request, Security, WebSocket
from fastapi.security import (
    APIKeyCookie,
    HTTPAuthorizationCredentials,
    HTTPBearer,
    SecurityScopes,
)
from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from iclip.common.errors import DomainError
from iclip.domains.identity.models import Principal, UserAccount
from iclip.domains.identity.rbac import PERMISSIONS
from iclip.domains.identity.service import IdentityService

SESSION_COOKIE_NAME = "iclip_session"
"""浏览器会话 cookie 的名字，是合同的一部分。"""

# 合同 ``securitySchemes`` 里的两个 scheme，名字是公开标识。它们只让 FastAPI 把端点权限写进
# OpenAPI；返回值没人读，身份仍只由 PrincipalMiddleware 解析一次。
SESSION_COOKIE = APIKeyCookie(
    name=SESSION_COOKIE_NAME, scheme_name="SessionCookie", auto_error=False
)
BEARER_TOKEN = HTTPBearer(scheme_name="BearerToken", auto_error=False)

SessionUserReader = Callable[[str], Awaitable[UserAccount | None]]


@dataclass(frozen=True, slots=True)
class PrincipalResolver:
    """把入站凭证解析为 Principal；供 HTTP 中间件与 WS 握手共用。"""

    read_session_user: SessionUserReader
    service: IdentityService

    async def resolve(
        self, headers: Mapping[str, str], cookies: Mapping[str, str]
    ) -> Principal | None:
        scheme, _, bearer_token = headers.get("authorization", "").partition(" ")
        if scheme.lower() == "bearer":
            token = bearer_token.strip()
            if not token:
                return None
            try:
                return await self.service.authenticate_api_key(token)
            except DomainError:
                return None
        raw_token = cookies.get(SESSION_COOKIE_NAME)
        if not raw_token:
            return None
        account = await self.read_session_user(raw_token)
        if account is None:
            return None
        try:
            return self.service.principal_for_user(account)
        except DomainError:
            return None


class PrincipalMiddleware:
    """纯 ASGI 中间件：对 http 与 websocket 握手统一建立 ``state.principal``。"""

    def __init__(self, app: ASGIApp, resolver: PrincipalResolver) -> None:
        self._app = app
        self._resolver = resolver

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in {"http", "websocket"}:
            # 请求及 WebSocket 生命周期内的日志共享请求与主体上下文。
            structlog.contextvars.clear_contextvars()
            structlog.contextvars.bind_contextvars(request_id=uuid.uuid4().hex[:12])
            connection = HTTPConnection(scope)
            principal = await self._resolver.resolve(connection.headers, connection.cookies)
            if principal is not None:
                structlog.contextvars.bind_contextvars(principal=principal.audit_label)
            bind_principal(connection, principal)
        await self._app(scope, receive, send)


def bind_principal(connection: HTTPConnection, principal: Principal | None) -> None:
    """把已解析的主体写到连接 state 上，``principal_of`` / ``websocket_principal`` 从这里读；``None`` 即匿名。"""

    connection.state.principal = principal


def principal_of(request: Request) -> Principal | None:
    return getattr(request.state, "principal", None)


def websocket_principal(websocket: WebSocket) -> Principal | None:
    return getattr(websocket.state, "principal", None)


async def require_authenticated(
    security_scopes: SecurityScopes,
    request: Request,
    _session_cookie: Annotated[str | None, Depends(SESSION_COOKIE)],
    _bearer_token: Annotated[HTTPAuthorizationCredentials | None, Depends(BEARER_TOKEN)],
) -> Principal:
    """路由依赖：取中间件已解析的主体，无主体 401；带 scopes 时逐项查权限，缺任一项 403。

    两个 scheme 参数只为让 OpenAPI 把这条端点的 ``security`` 写出来，值不读；凭证不在这里
    二次解析。``Depends(require_authenticated)`` 只要求登录，要权限用 ``require_permission``。
    """

    principal = principal_of(request)
    if principal is None:
        raise HTTPException(status_code=401, detail="未登录或凭证无效")
    missing = [scope for scope in security_scopes.scopes if not principal.has(scope)]
    if missing:
        raise HTTPException(status_code=403, detail=f"需要 {'、'.join(missing)} 权限")
    return principal


def require_permission(*permissions: str) -> Any:
    """声明端点要的权限，全部持有才放行：``Annotated[Principal, require_permission("tasks:read")]``。

    权限名在声明时对照 ``rbac.PERMISSIONS`` 校验，写错或一个不给就在路由注册时抛 ``ValueError``。
    返回值是 FastAPI 的 ``Security`` 标记，同一份 scopes 既用于运行时判定，也导出为合同 ``security``。
    """

    if not permissions:
        raise ValueError("require_permission 至少声明一项权限；只要登录用 require_authenticated")
    unknown = [permission for permission in permissions if permission not in PERMISSIONS]
    if unknown:
        raise ValueError(f"未知权限: {', '.join(unknown)}")
    return Security(require_authenticated, scopes=list(permissions))


def websocket_origin_allowed(websocket: WebSocket, allowed_origins: tuple[str, ...]) -> bool:
    """CSWSH 防护：无 Origin 放行（非浏览器）、白名单跨域、否则要求同源。"""

    origin = websocket.headers.get("origin")
    if origin is None:
        return True
    if origin in allowed_origins:
        return True
    host = websocket.headers.get("host", "")
    return bool(host) and urlsplit(origin).netloc == host


__all__ = [
    "BEARER_TOKEN",
    "SESSION_COOKIE",
    "SESSION_COOKIE_NAME",
    "PrincipalMiddleware",
    "PrincipalResolver",
    "bind_principal",
    "principal_of",
    "require_authenticated",
    "require_permission",
    "websocket_origin_allowed",
    "websocket_principal",
]
