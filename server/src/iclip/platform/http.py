"""领域错误 → HTTP 状态码的单点映射，以及请求校验错误的信封文案。

纯映射，不依赖 web 框架；FastAPI 异常处理器在 ``app/errors.py`` 安装并消费本模块。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Final

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


_REQUEST_PARTS: Final = frozenset({"body", "query", "path", "header", "cookie"})
"""Pydantic 位置的第一段是请求的哪一部分，对调用方没有信息量，拼文案时去掉。"""

_PYDANTIC_PREFIX: Final = "Value error, "
"""自定义校验器抛 ``ValueError`` 时 pydantic 加的前缀，去掉后就是我们自己写的那句话。"""

_FALLBACK: Final = "请求格式无效"


def validation_error_detail(errors: Sequence[Mapping[str, Any]]) -> str:
    """把请求校验错误压成一句话，供 ``{"detail": ...}`` 信封使用。

    取第一条：一次请求里后面几条通常是同一处问题的连带结果，全列出来反而看不清。
    形如 ``shot.timeline[0].image_indexes: 与正文里 @Image 的出现顺序不一致``；
    位置为空（模型级校验器报在请求体自身）时只留原因。
    """

    first = next(iter(errors), None)
    if first is None:
        return _FALLBACK
    message = str(first.get("msg", "")).removeprefix(_PYDANTIC_PREFIX).strip() or _FALLBACK
    # 正文不是合法 JSON 时，位置的第二段是字符偏移而非字段，拼出来只会误导。
    if first.get("type") == "json_invalid":
        return message
    location = _location_of(first.get("loc", ()))
    return f"{location}: {message}" if location else message


def _location_of(loc: Sequence[Any]) -> str:
    """把 pydantic 的位置元组拼成字段路径：下标写成 ``[n]``，其余用 ``.`` 连接。"""

    parts = list(loc)
    if parts and parts[0] in _REQUEST_PARTS:
        parts = parts[1:]
    rendered = ""
    for part in parts:
        if isinstance(part, int):
            rendered += f"[{part}]"
        elif rendered:
            rendered += f".{part}"
        else:
            rendered = str(part)
    return rendered


__all__ = ["status_code_for", "validation_error_detail"]
