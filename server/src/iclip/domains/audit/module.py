"""audit 装配单元：组合根只调用 ``build_audit_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.audit.api import create_audit_router
from iclip.domains.audit.repository import AuditReports
from iclip.domains.audit.service import AuditService


@dataclass(frozen=True)
class AuditModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: AuditService


def build_audit_module(reports: AuditReports) -> AuditModule:
    service = AuditService(reports)
    return AuditModule(routers=(create_audit_router(service),), service=service)


__all__ = ["AuditModule", "build_audit_module"]
