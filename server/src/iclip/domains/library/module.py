"""library 装配单元：组合根只调用 ``build_library_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.library.api import create_library_router
from iclip.domains.library.repository import LibraryReports
from iclip.domains.library.service import LibraryService


@dataclass(frozen=True)
class LibraryModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: LibraryService


def build_library_module(reports: LibraryReports) -> LibraryModule:
    service = LibraryService(reports)
    return LibraryModule(routers=(create_library_router(service),), service=service)


__all__ = ["LibraryModule", "build_library_module"]
