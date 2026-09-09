"""归属标签 ``user_name`` 的取值规则。上游按它落表对账；它不是身份，不参与授权。"""

from __future__ import annotations

from iclip.common.errors import ValidationFailed
from iclip.domains.identity.models import Principal


def resolve_user_name(principal: Principal, given: str | None) -> str:
    """定下这次请求发往上游的 ``user_name``。

    API key 调用方必须自己给，给什么用什么：它替自己的终端用户说话，我们不知道那个人是谁，
    也不拿 key 属主账号顶替。浏览器会话可以不给，用登录账号的用户名；给了就必须是自己的
    名字，免得把账记到别人头上。
    """

    name = given.strip() if given is not None else ""
    if principal.kind == "api_key":
        if not name:
            raise ValidationFailed("user_name 必填")
        return name
    if principal.username is None:
        raise ValidationFailed("当前账号没有用户名，不能提交")
    if name and name != principal.username:
        raise ValidationFailed("user_name 必须是当前登录账号的用户名")
    return principal.username


__all__ = ["resolve_user_name"]
