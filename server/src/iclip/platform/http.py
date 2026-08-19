"""领域错误 → HTTP 状态码的单点映射。

纯映射，不依赖 web 框架；FastAPI 异常处理器在组合根安装并消费本映射。
"""

from __future__ import annotations

from iclip.common.errors import (
    AuthenticationFailed,
    Conflict,
    DomainError,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

_STATUS_BY_TYPE: tuple[tuple[type[DomainError], int], ...] = (
    (NotFound, 404),
    (PermissionDenied, 403),
    (Conflict, 409),
    (ValidationFailed, 422),
    (AuthenticationFailed, 401),
)


def status_code_for(error: DomainError) -> int:
    """返回领域错误对应的 HTTP 状态码；未知子类归 500。"""

    for error_type, status in _STATUS_BY_TYPE:
        if isinstance(error, error_type):
            return status
    return 500


__all__ = ["status_code_for"]
