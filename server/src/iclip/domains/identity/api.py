"""identity HTTP 驱动适配器：认证、用户管理、API key、SSO 路由。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi_users import FastAPIUsers
from fastapi_users.exceptions import UserNotExists
from fastapi_users_db_sqlalchemy import SQLAlchemyUserDatabase

from iclip.common.errors import NotFound
from iclip.domains.identity.accounts import (
    CookieAuthSettings,
    UserCreate,
    UserManager,
    UserRead,
    build_cookie_backend,
    build_cookie_transport,
    build_jwt_strategy,
    make_user_manager_context,
)
from iclip.domains.identity.commands import CreateApiKey, UpdateUser
from iclip.domains.identity.infra_sql import OAuthAccount, SessionFactory, User
from iclip.domains.identity.middleware import require_authenticated, require_permission
from iclip.domains.identity.models import Principal
from iclip.domains.identity.pms import PmsUnavailable, PmsUserClient
from iclip.domains.identity.rbac import ROOT_ROLE
from iclip.domains.identity.repository import UserRepository
from iclip.domains.identity.schemas import (
    ApiKeyCreatedEnvelope,
    ApiKeyCreatedOut,
    ApiKeyCreateIn,
    ApiKeysEnvelope,
    SsoAuthorizeOut,
    UserEnvelope,
    UserPatchIn,
    UsersPageOut,
    api_key_out,
    user_out,
    user_out_for_principal,
)
from iclip.domains.identity.service import (
    IdentityService,
    SelfManagementForbidden,
)
from iclip.domains.identity.sso import (
    OAUTH_NAME,
    SsoSessionInvalid,
    SsoUnavailable,
    SsoVerifier,
    sso_placeholder_email,
)


def create_account_routers(
    sessions: SessionFactory,
    auth: CookieAuthSettings,
) -> tuple[APIRouter, ...]:
    """fastapi-users 的 /auth/login、/auth/logout 与 /auth/register。"""

    backend = build_cookie_backend(auth)

    async def get_user_db() -> AsyncIterator[SQLAlchemyUserDatabase[User, uuid.UUID]]:
        async with sessions() as session:
            yield SQLAlchemyUserDatabase(session, User, OAuthAccount)

    # 闭包依赖必须用默认值式 Depends：Annotated 内的字符串化注解无法解析闭包局部名。
    async def get_user_manager(
        user_db: SQLAlchemyUserDatabase[User, uuid.UUID] = Depends(get_user_db),  # noqa: B008
    ) -> AsyncIterator[UserManager]:
        yield UserManager(user_db, secret=auth.secret)

    fastapi_users = FastAPIUsers[User, uuid.UUID](get_user_manager, [backend])
    auth_router = APIRouter(prefix="/auth")
    auth_router.include_router(fastapi_users.get_auth_router(backend))
    auth_router.include_router(fastapi_users.get_register_router(UserRead, UserCreate))
    return (auth_router,)


def create_users_router(service: IdentityService) -> APIRouter:
    router = APIRouter()

    @router.get("/users/me", response_model=UserEnvelope)
    async def me(
        principal: Annotated[Principal, Depends(require_authenticated)],
    ) -> UserEnvelope:
        try:
            account = await service.get_account(principal.user_id)
        except NotFound as exc:
            raise HTTPException(status_code=401, detail="会话用户不存在") from exc
        return UserEnvelope(user=user_out_for_principal(account, principal))

    @router.get("/users", response_model=UsersPageOut)
    async def list_users(
        principal: Annotated[Principal, Depends(require_permission("users:manage"))],
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(alias="pageSize", ge=1, le=200)] = 50,
    ) -> UsersPageOut:
        accounts, total = await service.list_users_page(principal, page=page, page_size=page_size)
        return UsersPageOut(
            items=[user_out(account) for account in accounts],
            total=total,
            page=page,
            page_size=page_size,
        )

    @router.patch("/users/{user_id}", response_model=UserEnvelope)
    async def patch_user(
        user_id: uuid.UUID,
        patch: UserPatchIn,
        principal: Annotated[Principal, Depends(require_permission("users:manage"))],
    ) -> UserEnvelope:
        try:
            account = await service.update_user(
                principal,
                user_id,
                UpdateUser(
                    roles=tuple(patch.roles) if patch.roles is not None else None,
                    direct_permissions=(
                        frozenset(patch.direct_permissions)
                        if patch.direct_permissions is not None
                        else None
                    ),
                    is_active=patch.is_active,
                ),
            )
        except SelfManagementForbidden as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return UserEnvelope(user=user_out(account))

    return router


def create_api_keys_router(service: IdentityService) -> APIRouter:
    router = APIRouter()

    @router.post("/api-keys", response_model=ApiKeyCreatedEnvelope, status_code=201)
    async def create_key(
        body: ApiKeyCreateIn,
        principal: Annotated[Principal, Depends(require_authenticated)],
    ) -> ApiKeyCreatedEnvelope:
        record, token = await service.issue_api_key(
            principal,
            CreateApiKey(
                name=body.name,
                permissions=frozenset(body.permissions),
                expires_at=body.expires_at,
            ),
        )
        base = api_key_out(record)
        return ApiKeyCreatedEnvelope(
            api_key=ApiKeyCreatedOut(**base.model_dump(by_alias=False), token=token)
        )

    @router.get("/api-keys", response_model=ApiKeysEnvelope)
    async def list_keys(
        principal: Annotated[Principal, Depends(require_authenticated)],
    ) -> ApiKeysEnvelope:
        records = await service.list_api_keys(principal)
        return ApiKeysEnvelope(api_keys=[api_key_out(r) for r in records])

    @router.delete("/api-keys/{key_id}", status_code=204)
    async def revoke_key(
        key_id: uuid.UUID,
        principal: Annotated[Principal, Depends(require_authenticated)],
    ) -> Response:
        await service.revoke_api_key(principal, key_id)
        return Response(status_code=204)

    return router


def create_sso_router(
    sessions: SessionFactory,
    auth: CookieAuthSettings,
    verifier: SsoVerifier,
    pms_client: PmsUserClient | None,
    users: UserRepository,
    root_email: str | None,
) -> APIRouter:
    router = APIRouter(prefix="/auth/sso")
    user_manager_ctx = make_user_manager_context(sessions, secret=auth.secret)

    @router.get("/authorize", response_model=SsoAuthorizeOut)
    async def authorize() -> SsoAuthorizeOut:
        return SsoAuthorizeOut(authorization_url=verifier.authorization_url())

    @router.get("/callback")
    async def callback(jwt: str) -> Response:
        try:
            session = await verifier.verify(jwt)
        except SsoSessionInvalid as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        except SsoUnavailable as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        profile = None
        if pms_client is not None:
            try:
                profile = await pms_client.get_user(
                    inner_user_id=session.inner_user_id, authorization=jwt
                )
            except PmsUnavailable as exc:
                # PMS 启用即资料同步是登录链路的一部分：失败终止本次 callback。
                raise HTTPException(status_code=502, detail=str(exc)) from exc

        async with user_manager_ctx() as manager:
            was_new = False
            try:
                await manager.get_by_oauth_account(OAUTH_NAME, session.union_id)
            except UserNotExists:
                was_new = True
            email = session.email or sso_placeholder_email(session.union_id)
            # fastapi-users 的 oauth_callback 泛型 self 绑定过窄（UOAP 不变型），
            # User 实际满足 OAuth 协议（持有 oauth_accounts relationship）。
            user = await manager.oauth_callback(  # pyright: ignore[reportAttributeAccessIssue]
                OAUTH_NAME,
                access_token=jwt,
                account_id=session.union_id,
                account_email=email,
                associate_by_email=True,
                is_verified_by_default=True,
            )

        await users.sync_sso_profile(
            user.id,
            display_name=session.name,
            avatar_url=session.avatar_url,
            roles=("editor",) if was_new else None,
            city=profile.city if profile is not None else None,
            job_title=profile.job_title if profile is not None else None,
            departments=profile.departments if profile is not None else None,
        )
        # root 引导：配置指定的邮箱登录即确保持有 root 角色（唯一自动授权入口）。
        if root_email and user.email.lower() == root_email.lower():
            await users.ensure_role(user.id, ROOT_ROLE)
        await users.touch_last_login(user.id, datetime.now(UTC))

        token = await build_jwt_strategy(auth).write_token(user)
        return await build_cookie_transport(auth).get_login_response(token)

    return router


__all__ = [
    "create_account_routers",
    "create_api_keys_router",
    "create_sso_router",
    "create_users_router",
]
