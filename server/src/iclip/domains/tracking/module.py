"""tracking 装配单元：组合根只调用 ``build_tracking_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.tracking.api import create_tracking_router
from iclip.domains.tracking.repository import TrackingRepository
from iclip.domains.tracking.service import TrackingService


@dataclass(frozen=True)
class TrackingModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: TrackingService


def build_tracking_module(repository: TrackingRepository) -> TrackingModule:
    service = TrackingService(repository)
    return TrackingModule(routers=(create_tracking_router(service),), service=service)


__all__ = ["TrackingModule", "build_tracking_module"]
