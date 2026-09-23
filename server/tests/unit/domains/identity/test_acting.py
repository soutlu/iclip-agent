"""钥匙替人办事的三条规则：浏览器只核对自己的名字，无权限的钥匙原样返回，有权限的换属主。"""

from __future__ import annotations

import uuid

import pytest

from iclip.common.errors import ValidationFailed
from iclip.domains.identity.acting import (
    ACT_AS_PERMISSION,
    ActAs,
    is_placeholder_account,
    placeholder_email,
)
from iclip.domains.identity.models import Principal
from iclip.domains.identity.sso import sso_placeholder_email
from tests.helpers.identity import InMemoryUserRepository, make_account


def browser(username: str | None = "luke") -> Principal:
    return Principal(
        kind="user",
        user_id=uuid.uuid4(),
        permissions=frozenset({"agent:run"}),
        audit_label="luke",
        username=username,
    )


def api_key(*permissions: str) -> Principal:
    return Principal(
        kind="api_key",
        user_id=uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="luke#multiflow",
        api_key_id=uuid.uuid4(),
        username="luke",
        key_name="multiflow",
    )


async def test_browser_session_keeps_itself_and_may_only_name_itself() -> None:
    act_as = ActAs(InMemoryUserRepository())
    me = browser()

    assert await act_as(me, None) is me
    assert await act_as(me, " luke ") is me
    with pytest.raises(ValidationFailed, match="必须是当前登录账号的用户名"):
        await act_as(me, "Shan.Hu")


async def test_key_without_the_permission_is_untouched_and_creates_nobody() -> None:
    users = InMemoryUserRepository()
    key = api_key("agent:run")

    assert await act_as_with(users)(key, "Shan.Hu") is key
    assert users.accounts == {}


async def test_key_with_the_permission_acts_as_the_named_person() -> None:
    users = InMemoryUserRepository()
    key = api_key("agent:run", ACT_AS_PERMISSION)

    acting = await act_as_with(users)(key, "Shan.Hu")

    (placeholder,) = users.accounts.values()
    assert placeholder.username == "Shan.Hu"
    assert placeholder.roles == ()
    assert is_placeholder_account("Shan.Hu", placeholder.email)
    assert acting.user_id == placeholder.id
    assert acting.username == "Shan.Hu"
    assert acting.audit_label == "Shan.Hu#multiflow"
    # 权限与钥匙身份都还是钥匙自己的：报一个 root 的名字换不来 root 的权限。
    assert acting.permissions == key.permissions
    assert acting.api_key_id == key.api_key_id
    assert acting.kind == "api_key"


async def test_an_existing_account_is_reused_instead_of_a_placeholder() -> None:
    rudy = make_account(username="Rudy", email="rudy@corp.test")
    users = InMemoryUserRepository([rudy])

    acting = await act_as_with(users)(api_key(ACT_AS_PERMISSION), "Rudy")

    assert acting.user_id == rudy.id
    assert len(users.accounts) == 1


async def test_blank_name_means_nobody_to_act_as() -> None:
    users = InMemoryUserRepository()
    key = api_key(ACT_AS_PERMISSION)
    for blank in (None, "", "   "):
        assert await act_as_with(users)(key, blank) is key
    assert users.accounts == {}


def test_placeholder_email_is_deterministic_per_name() -> None:
    assert placeholder_email("Shan.Hu") == placeholder_email("Shan.Hu")
    assert placeholder_email("Shan.Hu") != placeholder_email("shan.hu")


def test_placeholder_account_is_recognized_only_by_its_own_name() -> None:
    assert is_placeholder_account("Shan.Hu", placeholder_email("Shan.Hu"))
    assert not is_placeholder_account("Shan.Hu", "shan.hu@mirmiles.com")
    # SSO 无邮箱的真人与占位账号同域，不能因为后缀相同就被当成空座。
    assert not is_placeholder_account("Shan.Hu", sso_placeholder_email("u-7"))
    # 大小写不同或换一个名字，合成出来的都不是这一个。
    assert not is_placeholder_account("shan.hu", placeholder_email("Shan.Hu"))
    assert not is_placeholder_account("Rudy", placeholder_email("Shan.Hu"))


def act_as_with(users: InMemoryUserRepository) -> ActAs:
    return ActAs(users)
