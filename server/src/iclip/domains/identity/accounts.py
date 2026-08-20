"""fastapi-users 装配：UserManager、cookie-JWT 认证后端、注册 schema。

密码注册强制 ``roles=["viewer"]``（列默认值 + UserCreate 无 roles 字段）；登录支持
username 或 email；登录成功刷新 ``last_login_at``。
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import Response
from fastapi.security import OAuth2PasswordRequestForm
from fastapi_users import BaseUserManager, InvalidPasswordException, UUIDIDMixin, schemas
from fastapi_users.authentication import (
    AuthenticationBackend,
    CookieTransport,
    JWTStrategy,
)
from fastapi_users.exceptions import UserAlreadyExists
from fastapi_users_db_sqlalchemy import SQLAlchemyUserDatabase
from starlette.requests import Request

from iclip.domains.identity.infra_sql import (
    OAuthAccount,
    SessionFactory,
    User,
    get_user_row_by_username,
)

_MIN_PASSWORD_LENGTH = 8


@dataclass(frozen=True, slots=True)
class CookieAuthSettings:
    """identity 自持的会话认证运行设置；组合根从 RuntimeConfig 映射而来。"""

    secret: str
    cookie_name: str
    lifetime_seconds: int
    cookie_secure: bool


class UserRead(schemas.BaseUser[uuid.UUID]):
    username: str | None = None
    roles: list[str] = ["viewer"]  # noqa: RUF012 — pydantic 字段默认值按实例拷贝


class UserCreate(schemas.BaseUserCreate):
    username: str | None = None


class UserManager(UUIDIDMixin, BaseUserManager[User, uuid.UUID]):
    def __init__(self, user_db: SQLAlchemyUserDatabase[User, uuid.UUID], *, secret: str) -> None:
        super().__init__(user_db)
        self.reset_password_token_secret = secret
        self.verification_token_secret = secret
        self._user_db = user_db

    async def validate_password(self, password: str, user: object) -> None:
        if len(password) < _MIN_PASSWORD_LENGTH:
            raise InvalidPasswordException(reason=f"密码长度必须 ≥ {_MIN_PASSWORD_LENGTH} 字符")

    async def create(
        self,
        user_create: schemas.BaseUserCreate,
        safe: bool = False,
        request: Request | None = None,
    ) -> User:
        username = getattr(user_create, "username", None)
        if username:
            existing = await self._get_by_username(username)
            if existing is not None:
                raise UserAlreadyExists()
        return await super().create(user_create, safe=safe, request=request)

    async def authenticate(self, credentials: OAuth2PasswordRequestForm) -> User | None:
        # 支持 username 或 email 登录：非邮箱形态先按 username 解析成 email。
        identifier = credentials.username
        if "@" not in identifier:
            row = await self._get_by_username(identifier)
            if row is not None:
                credentials.username = row.email
        return await super().authenticate(credentials)

    async def on_after_login(
        self,
        user: User,
        request: Request | None = None,
        response: Response | None = None,
    ) -> None:
        await self._user_db.update(user, {"last_login_at": datetime.now(UTC)})

    async def _get_by_username(self, username: str) -> User | None:
        return await get_user_row_by_username(self._user_db.session, username)


def build_cookie_transport(auth: CookieAuthSettings) -> CookieTransport:
    return CookieTransport(
        cookie_name=auth.cookie_name,
        cookie_max_age=auth.lifetime_seconds,
        cookie_secure=auth.cookie_secure,
        cookie_samesite="lax",
    )


def build_jwt_strategy(auth: CookieAuthSettings) -> JWTStrategy[User, uuid.UUID]:
    return JWTStrategy(secret=auth.secret, lifetime_seconds=auth.lifetime_seconds)


def build_cookie_backend(auth: CookieAuthSettings) -> AuthenticationBackend[User, uuid.UUID]:
    return AuthenticationBackend(
        name="cookie",
        transport=build_cookie_transport(auth),
        get_strategy=lambda: build_jwt_strategy(auth),
    )


def make_user_manager_context(sessions: SessionFactory, *, secret: str):
    """返回组合根/协议客户端使用的 per-call UserManager 上下文工厂。"""

    @asynccontextmanager
    async def user_manager_ctx() -> AsyncGenerator[UserManager]:
        async with sessions() as session:
            user_db: SQLAlchemyUserDatabase[User, uuid.UUID] = SQLAlchemyUserDatabase(
                session, User, OAuthAccount
            )
            yield UserManager(user_db, secret=secret)

    return user_manager_ctx


__all__ = [
    "CookieAuthSettings",
    "UserCreate",
    "UserManager",
    "UserRead",
    "build_cookie_backend",
    "build_cookie_transport",
    "build_jwt_strategy",
    "make_user_manager_context",
]
