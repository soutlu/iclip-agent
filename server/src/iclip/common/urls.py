"""地址形状的共用判定。"""

from __future__ import annotations

from typing import Final
from urllib.parse import urlsplit

_HTTP_SCHEMES: Final = frozenset({"http", "https"})


def is_http_url(value: str) -> bool:
    """是否为带主机名、不含空白的 http(s) 地址；纯判定，不抛异常。"""

    # urlsplit 会先剥掉首尾空白与 \t\r\n，只能在原串上查。
    if any(ch.isspace() for ch in value):
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:  # 方括号不配对之类的畸形 netloc，urlsplit 直接抛
        return False
    return parsed.scheme in _HTTP_SCHEMES and bool(parsed.hostname)


__all__ = ["is_http_url"]
