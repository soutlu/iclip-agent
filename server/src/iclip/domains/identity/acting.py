"""钥匙替人办事：持 ``users:act_as`` 的 API key 带 ``user_name`` 时，本次请求以那个人为属主。"""

from __future__ import annotations

import uuid
from dataclasses import replace

from iclip.common.errors import ValidationFailed
from iclip.domains.identity.models import Principal
from iclip.domains.identity.repository import UserRepository
from iclip.domains.identity.sso import SSO_EMAIL_PLACEHOLDER_DOMAIN

ACT_AS_PERMISSION = "users:act_as"
"""钥匙可以替 ``user_name`` 那个人提交。能替任何人写，也就能读任何人的记录。"""

_PLACEHOLDER_NAMESPACE = uuid.UUID("8f0c6a1e-5b7d-4e2a-9c3f-1d4b6e8a0c2f")


def placeholder_email(username: str) -> str:
    """占位账号的邮箱。邮箱列非空且唯一，本人 SSO 登录时换成真的。"""

    return f"{uuid.uuid5(_PLACEHOLDER_NAMESPACE, username).hex}@{SSO_EMAIL_PLACEHOLDER_DOMAIN}"


def is_placeholder_email(email: str) -> bool:
    return email.endswith(f"@{SSO_EMAIL_PLACEHOLDER_DOMAIN}")


class ActAs:
    """把请求主体换成 ``user_name`` 那个人。

    浏览器会话只核对名字是不是自己的；钥匙没有 ``users:act_as`` 就原样返回，名字仍只是
    发往上游的标签；钥匙有它并给了名字，属主换成那个人（没有账号就建占位账号），权限仍
    用钥匙自己的，审计标识变成「那个人#钥匙名」。
    """

    def __init__(self, users: UserRepository) -> None:
        self._users = users

    async def __call__(self, principal: Principal, user_name: str | None) -> Principal:
        name = user_name.strip() if user_name else ""
        if not name:
            return principal
        if principal.kind != "api_key":
            if name != principal.username:
                raise ValidationFailed("user_name 必须是当前登录账号的用户名")
            return principal
        if not principal.has(ACT_AS_PERMISSION):
            return principal
        user_id = await self._users.ensure_by_name(name, email=placeholder_email(name))
        return replace(
            principal,
            user_id=user_id,
            username=name,
            audit_label=f"{name}#{principal.key_name}",
        )


__all__ = ["ACT_AS_PERMISSION", "ActAs", "is_placeholder_email", "placeholder_email"]
