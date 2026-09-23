"""读取范围的两种口径：治理者看全部；再放宽一档时，持 users:act_as 的钥匙也看全部。"""

from __future__ import annotations

import uuid

import pytest

from iclip.domains.identity.models import Principal, PrincipalKind
from iclip.domains.identity.rbac import ACT_AS_PERMISSION, MANAGE_PERMISSION
from iclip.domains.identity.visibility import visible_owner, visible_owner_incl_act_as


def principal(kind: PrincipalKind, *permissions: str) -> Principal:
    return Principal(
        kind=kind,
        user_id=uuid.uuid4(),
        permissions=frozenset({"agent:read", *permissions}),
        audit_label="luke",
        api_key_id=uuid.uuid4() if kind == "api_key" else None,
        username="luke",
        key_name="multiflow" if kind == "api_key" else None,
    )


@pytest.mark.parametrize(
    ("who", "expected_all", "expected_all_incl_act_as"),
    [
        (principal("user"), False, False),
        (principal("user", MANAGE_PERMISSION), True, True),
        (principal("api_key", MANAGE_PERMISSION), True, True),
        (principal("api_key", ACT_AS_PERMISSION), False, True),
        (principal("api_key"), False, False),
        # 用户账号被授予 act_as 也替不了人，读取范围不跟着放开。
        (principal("user", ACT_AS_PERMISSION), False, False),
    ],
    ids=[
        "plain-user",
        "governor-user",
        "governor-key",
        "act-as-key",
        "plain-key",
        "user-with-act-as-grant",
    ],
)
def test_owner_filter_is_none_only_for_those_who_see_everyone(
    who: Principal, expected_all: bool, expected_all_incl_act_as: bool
) -> None:
    assert visible_owner(who) == (None if expected_all else who.user_id)
    assert visible_owner_incl_act_as(who) == (None if expected_all_incl_act_as else who.user_id)
