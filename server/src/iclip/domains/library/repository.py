"""资料库的读取协议。实现在 reports_pg.py，服务层只依赖这里。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from iclip.domains.library.models import Scope, VideoCursor
from iclip.domains.library.schemas import LibraryAuthorOut, LibraryVideoOut, TakeOut


@dataclass(frozen=True, slots=True)
class CardRow:
    """一张卡连同来源对话的属主；``video.conversation_id`` 尚未按读者裁剪。"""

    video: LibraryVideoOut
    conversation_owner: uuid.UUID | None


class LibraryReports(Protocol):
    async def videos(
        self, scope: Scope, *, limit: int, after: VideoCursor | None
    ) -> Sequence[CardRow]:
        """卡面时刻晚的排前面。"""
        ...

    async def count(self, scope: Scope) -> int:
        """筛选范围里一共几张卡。"""
        ...

    async def card_of(self, video_id: uuid.UUID) -> CardRow | None:
        """这次出片所在的那张卡；它不在资料库里（没成、已删对话、分叉拷贝等）就是 ``None``。"""
        ...

    async def takes_of(self, video_id: uuid.UUID) -> Sequence[TakeOut]:
        """这次出片所在那一镜的全部成功出片，早的在前。"""
        ...

    async def siblings_of(self, video_id: uuid.UUID) -> Sequence[CardRow]:
        """同一段对话里的其他镜，镜号小的在前；不挂对话的出片没有兄弟。"""
        ...

    async def authors(self) -> Sequence[LibraryAuthorOut]:
        """每个名下有卡的人一行，卡多的排前面。"""
        ...


__all__ = ["CardRow", "LibraryReports"]
