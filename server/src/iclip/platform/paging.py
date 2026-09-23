"""列表翻页的共用协议：游标编解码与列表上限，各域共用一份。

游标是「上一页末行的排序键」的文本形态，不签名、不加密，只是把排序键原样带回来。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final

from iclip.common.errors import ValidationFailed

MAX_LIST_LIMIT: Final = 100
DEFAULT_LIST_LIMIT: Final = 20

_SEPARATOR: Final = "|"

BAD_CURSOR: Final = "cursor 不是一个有效的翻页位置"
"""解析失败一律给这一句：调用方只需要知道这个游标不能用，分不清哪一段坏了没有意义。
各域校验自己的尾键形状时也用这一句。"""


@dataclass(frozen=True, slots=True)
class Cursor:
    """时间戳加一个断言唯一的尾键；两段都不许空。"""

    at: datetime
    key: str

    def uuid_key(self) -> uuid.UUID:
        """尾键按 UUID 读；不是 UUID 就不是本列表发出去的游标。"""

        try:
            return uuid.UUID(self.key)
        except ValueError as exc:
            raise ValidationFailed(BAD_CURSOR) from exc


def encode_cursor(at: datetime, key: object) -> str:
    """把排序键拼成游标；尾键按 ``str()`` 写出。"""

    return f"{at.isoformat()}{_SEPARATOR}{key}"


def decode_cursor(raw: str) -> Cursor:
    """解析游标；缺分隔符、任一段为空、时间戳不合法都抛 ``ValidationFailed``。"""

    stamp, separator, key = raw.partition(_SEPARATOR)
    if not separator or not stamp or not key:
        raise ValidationFailed(BAD_CURSOR)
    try:
        at = datetime.fromisoformat(stamp)
    except ValueError as exc:
        raise ValidationFailed(BAD_CURSOR) from exc
    return Cursor(at=at, key=key)


def check_limit(limit: int) -> None:
    """列表每页条数越界时抛 ``ValidationFailed``。"""

    if not 1 <= limit <= MAX_LIST_LIMIT:
        raise ValidationFailed(f"limit 必须在 1 到 {MAX_LIST_LIMIT} 之间")


__all__ = [
    "BAD_CURSOR",
    "DEFAULT_LIST_LIMIT",
    "MAX_LIST_LIMIT",
    "Cursor",
    "check_limit",
    "decode_cursor",
    "encode_cursor",
]
