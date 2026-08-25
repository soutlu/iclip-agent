"""uploads 装配单元：组合根只调用 ``build_uploads_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.uploads.api import create_uploads_router
from iclip.platform.object_store.oss import PublicObjectStore


@dataclass(frozen=True, slots=True)
class UploadsModule:
    routers: tuple[Any, ...]
    """路由的类型写 ``Any``（同 identity / conversations）：装配单元不该把 web 框架拖进这一环。"""


def build_uploads_module(store: PublicObjectStore) -> UploadsModule:
    """装配 uploads。

    对象存储由组合根给：桶和密钥是环境的事实。没配对象存储时组合根干脆不装这一环，
    这组路由就整个不挂载（同产品资料与爆款视频没配目录库时的做法）。
    """

    return UploadsModule(routers=(create_uploads_router(store),))


__all__ = ["UploadsModule", "build_uploads_module"]
