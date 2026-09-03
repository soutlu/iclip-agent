"""Principal 解析：唯一可信身份建立点，传输无关（HTTP / WebSocket 握手）。

每 hop 只解析一次：cookie 会话 JWT 验签一次 + 活跃用户加载一次，或
Bearer API key 哈希查表一次。任何一步失败即匿名（None），受保护路由 401。
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit

import structlog
from fastapi import HTTPException, Request, WebSocket
from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from iclip.common.errors import DomainError
from iclip.domains.identity.models import Principal, UserAccount
from iclip.domains.identity.service import API_KEY_TOKEN_PREFIX, IdentityService

SessionUserReader = Callable[[str], Awaitable[UserAccount | None]]


@dataclass(frozen=True, slots=True)
class PrincipalResolver:
    """把入站凭证解析为 Principal；供 HTTP 中间件与 WS 握手共用。"""

    cookie_name: str
    read_session_user: SessionUserReader
    service: IdentityService

    async def resolve(
        self, headers: Mapping[str, str], cookies: Mapping[str, str]
    ) -> Principal | None:
        scheme, _, bearer_token = headers.get("authorization", "").partition(" ")
        if scheme.lower() == "bearer":
            token = bearer_token.strip()
            if token.startswith(API_KEY_TOKEN_PREFIX):
                try:
                    return await self.service.authenticate_api_key(token)
                except DomainError:
                    return None
            return None
        raw_token = cookies.get(self.cookie_name)
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
            # 这条请求（或这条 WS 连接）里打的每一行日志都带上是谁、哪一次；uvicorn 的访问行也在内
            structlog.contextvars.clear_contextvars()
            structlog.contextvars.bind_contextvars(request_id=uuid.uuid4().hex[:12])
            connection = HTTPConnection(scope)
            principal = await self._resolver.resolve(connection.headers, connection.cookies)
            if principal is not None:
                structlog.contextvars.bind_contextvars(principal=principal.audit_label)
            state = scope.setdefault("state", {})
            state["principal"] = principal
        await self._app(scope, receive, send)


def principal_of(request: Request) -> Principal | None:
    return getattr(request.state, "principal", None)


def websocket_principal(websocket: WebSocket) -> Principal | None:
    return getattr(websocket.state, "principal", None)


async def require_authenticated(request: Request) -> Principal:
    principal = principal_of(request)
    if principal is None:
        raise HTTPException(status_code=401, detail="未登录或凭证无效")
    return principal


def require_permission(permission: str) -> Callable[[Request], Awaitable[Principal]]:
    async def dependency(request: Request) -> Principal:
        principal = await require_authenticated(request)
        if not principal.has(permission):
            raise HTTPException(status_code=403, detail=f"需要 {permission} 权限")
        return principal

    return dependency


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
    "PrincipalMiddleware",
    "PrincipalResolver",
    "principal_of",
    "require_authenticated",
    "require_permission",
    "websocket_origin_allowed",
    "websocket_principal",
]
