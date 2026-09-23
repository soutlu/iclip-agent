"""钥匙替人办事：持 ``users:act_as`` 的 API key 带 ``user_name`` 时，本次请求以那个人为属主。"""

from __future__ import annotations

import uuid
from dataclasses import replace

import structlog

from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION
from iclip.domains.identity.repository import UserRepository
from iclip.domains.identity.sso import SSO_EMAIL_PLACEHOLDER_DOMAIN
from iclip.domains.identity.user_name import require_own_user_name

_PLACEHOLDER_NAMESPACE = uuid.UUID("8f0c6a1e-5b7d-4e2a-9c3f-1d4b6e8a0c2f")


def placeholder_email(username: str) -> str:
    """占位账号的邮箱。邮箱列非空且唯一，本人 SSO 登录时换成真的。"""

    return f"{uuid.uuid5(_PLACEHOLDER_NAMESPACE, username).hex}@{SSO_EMAIL_PLACEHOLDER_DOMAIN}"


def is_placeholder_account(username: str, email: str) -> bool:
    """这个用户名的账号是否仍挂着为它合成的占位邮箱。

    按用户名重建后精确比对而不看后缀：SSO 无邮箱的真人也落在同一个占位域下。
    """

    return email == placeholder_email(username)


class ActAs:
    """把请求主体换成 ``user_name`` 那个人。

    浏览器会话只核对名字是不是自己的；钥匙没有 ``users:act_as`` 就原样返回，名字仍只是
    发往上游的标签；钥匙有它并给了名字，属主换成那个人（没有账号就建占位账号），权限仍
    用钥匙自己的，审计标识变成「那个人#钥匙名」，本次请求的日志上下文加上 ``acting_as``。
    """

    def __init__(self, users: UserRepository) -> None:
        self._users = users

    async def __call__(self, principal: Principal, user_name: str | None) -> Principal:
        name = user_name.strip() if user_name else ""
        if not name:
            return principal
        if principal.kind != "api_key":
            require_own_user_name(principal, name)
            return principal
        if not principal.has(ACT_AS_PERMISSION):
            return principal
        user_id = await self._users.ensure_by_name(name, email=placeholder_email(name))
        # 中间件绑定的 principal 仍是钥匙原来的标识，这里只补上换成了谁。
        structlog.contextvars.bind_contextvars(acting_as=name)
        return replace(
            principal,
            user_id=user_id,
            username=name,
            audit_label=f"{name}#{principal.key_name}",
        )


__all__ = ["ActAs", "is_placeholder_account", "placeholder_email"]
