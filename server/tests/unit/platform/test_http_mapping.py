"""领域错误 → HTTP 状态码单点映射。"""

from __future__ import annotations

from iclip.common.errors import (
    AuthenticationFailed,
    Conflict,
    DomainError,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from iclip.platform.http import status_code_for


def test_mapping_table() -> None:
    assert status_code_for(NotFound()) == 404
    assert status_code_for(PermissionDenied()) == 403
    assert status_code_for(Conflict()) == 409
    assert status_code_for(ValidationFailed()) == 422
    assert status_code_for(AuthenticationFailed()) == 401


def test_unknown_subclass_maps_to_500() -> None:
    class Weird(DomainError):
        pass

    assert status_code_for(Weird()) == 500


def test_subclass_inherits_parent_status() -> None:
    class SelfishAction(ValidationFailed):
        pass

    assert status_code_for(SelfishAction()) == 422
