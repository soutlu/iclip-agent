"""翻页游标的编解码契约与列表上限边界。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from iclip.common.errors import ValidationFailed
from iclip.platform.paging import (
    MAX_LIST_LIMIT,
    check_limit,
    decode_cursor,
    encode_cursor,
)

AT = datetime(2026, 9, 15, 12, 0, tzinfo=UTC)


def test_cursor_round_trips_a_uuid_key() -> None:
    key = uuid.uuid4()

    parsed = decode_cursor(encode_cursor(AT, key))

    assert parsed.at == AT
    assert parsed.uuid_key() == key


def test_cursor_keeps_a_key_with_colons() -> None:
    """尾键自己带分隔符也不能被切开：异常游标的尾键就是「种类:对象」。"""

    parsed = decode_cursor(encode_cursor(AT, "retry:9d1b:2"))

    assert parsed.at == AT
    assert parsed.key == "retry:9d1b:2"


@pytest.mark.parametrize(
    "raw",
    [
        "nonsense",
        "2026-09-15T12:00:00+00:00|",
        "|3f0c1d8e-0000-4000-8000-000000000000",
        "not-a-date|3f0c1d8e-0000-4000-8000-000000000000",
    ],
    ids=["缺分隔符", "尾键空", "时间戳空", "时间戳坏"],
)
def test_malformed_cursors_are_rejected(raw: str) -> None:
    with pytest.raises(ValidationFailed, match="cursor"):
        decode_cursor(raw)


def test_non_uuid_key_is_rejected_only_when_read_as_uuid() -> None:
    """尾键是不是 UUID 由消费方决定：解析时放行，``uuid_key()`` 才校验。"""

    parsed = decode_cursor(encode_cursor(AT, "not-a-uuid"))

    with pytest.raises(ValidationFailed, match="cursor"):
        parsed.uuid_key()


@pytest.mark.parametrize("limit", [1, MAX_LIST_LIMIT])
def test_limit_inside_the_range_passes(limit: int) -> None:
    check_limit(limit)


@pytest.mark.parametrize("limit", [0, MAX_LIST_LIMIT + 1])
def test_limit_outside_the_range_is_rejected(limit: int) -> None:
    with pytest.raises(ValidationFailed, match="limit"):
        check_limit(limit)
