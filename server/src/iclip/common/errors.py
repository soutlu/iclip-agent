"""领域错误分类学。

各域 service 只抛这些类型；HTTP 状态码映射见 platform/http.py，
FastAPI 异常处理器安装在组合根。
"""

from __future__ import annotations


class DomainError(Exception):
    """所有领域错误的基类。"""


class NotFound(DomainError):
    """资源不存在，或对当前主体不可见（不泄露存在性）。"""


class PermissionDenied(DomainError):
    """资源可见但当前主体无权操作。"""


class Conflict(DomainError):
    """并发或状态冲突（如乐观并发版本不匹配）。"""


class ValidationFailed(DomainError):
    """输入在领域规则层面无效。"""


class AuthenticationFailed(DomainError):
    """主体凭证缺失或无效。"""


__all__ = [
    "AuthenticationFailed",
    "Conflict",
    "DomainError",
    "NotFound",
    "PermissionDenied",
    "ValidationFailed",
]
