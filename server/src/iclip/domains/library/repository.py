"""资料库的读取协议。实现在 reports_pg.py，服务层只依赖这里。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from iclip.domains.library.models import Scope, VideoCursor
from iclip.domains.library.schemas import LibraryAuthorOut, LibraryVideoOut, ShotGroupOut


@dataclass(frozen=True, slots=True)
class CardRow:
    """一张卡连同来源对话的属主与删除标记；``video.can_open_conversation`` 尚未按读者算。"""

    video: LibraryVideoOut
    conversation_owner: uuid.UUID | None
    conversation_deleted: bool


class LibraryReports(Protocol):
    async def videos(
        self, scope: Scope, *, limit: int, after: VideoCursor | None
    ) -> Sequence[CardRow]:
        """卡面完成时刻晚的排前面，同一时刻按卡 id 倒序。"""
        ...

    async def count(self, scope: Scope) -> int:
        """筛选范围里一共几张卡。"""
        ...

    async def card_of(self, card_id: uuid.UUID) -> CardRow | None:
        """这张卡；``card_id`` 不是卡 id（出片 id、编辑段、只继承没有自己成片的对话等）就是 ``None``。"""
        ...

    async def groups_of(self, card_id: uuid.UUID) -> Sequence[ShotGroupOut]:
        """这张卡的镜头组，顺序同详情；不是卡 id 就是空。"""
        ...

    async def authors(self) -> Sequence[LibraryAuthorOut]:
        """每个作者一行，卡多的排前面。"""
        ...


__all__ = ["CardRow", "LibraryReports"]
