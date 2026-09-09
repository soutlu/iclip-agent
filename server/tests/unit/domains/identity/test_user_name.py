"""归属标签 user_name 的取值规则：API key 自己给，浏览器会话用登录名。"""

from __future__ import annotations

import uuid

import pytest

from iclip.common.errors import ValidationFailed
from iclip.domains.identity.models import Principal, PrincipalKind
from iclip.domains.identity.user_name import resolve_user_name


def principal(kind: PrincipalKind, *, username: str | None = "luke") -> Principal:
    return Principal(
        kind=kind,
        user_id=uuid.uuid4(),
        permissions=frozenset(),
        audit_label="luke",
        api_key_id=uuid.uuid4() if kind == "api_key" else None,
        username=username,
    )


def test_api_key_caller_must_name_its_user_and_is_taken_at_its_word() -> None:
    assert resolve_user_name(principal("api_key"), " alice ") == "alice"
    for missing in (None, "", "   "):
        with pytest.raises(ValidationFailed, match="user_name 必填"):
            resolve_user_name(principal("api_key"), missing)


def test_browser_session_defaults_to_and_must_match_the_login_username() -> None:
    assert resolve_user_name(principal("user"), None) == "luke"
    assert resolve_user_name(principal("user"), "") == "luke"
    assert resolve_user_name(principal("user"), " luke ") == "luke"
    with pytest.raises(ValidationFailed, match="必须是当前登录账号的用户名"):
        resolve_user_name(principal("user"), "bob")


def test_browser_session_without_a_username_cannot_submit() -> None:
    """没有用户名既填不出默认值，也核对不了给的名字，两条路都拒。"""

    for given in (None, "luke"):
        with pytest.raises(ValidationFailed, match="没有用户名"):
            resolve_user_name(principal("user", username=None), given)
