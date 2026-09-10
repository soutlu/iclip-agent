"""工具入参归一化：字符串还原、非字符串放行、非法字符串按校验错误退回。"""

from __future__ import annotations

import json
from typing import Annotated

import pytest
from pydantic import BaseModel, ValidationError
from structlog.testing import capture_logs

from iclip.common.tool_args import JsonText


class Region(BaseModel):
    x: int
    y: int


class Args(BaseModel):
    region: Annotated[Region, JsonText]
    items: Annotated[list[int], JsonText]


def test_a_stringified_object_or_array_is_restored_and_logged() -> None:
    with capture_logs() as logs:
        args = Args.model_validate(
            {"region": json.dumps({"x": 1, "y": 2}), "items": json.dumps([3, 4])}
        )

    assert (args.region, args.items) == (Region(x=1, y=2), [3, 4])
    parsed = [log for log in logs if log["event"] == "工具参数以字符串传入，已解析"]
    assert sorted(log["field"] for log in parsed) == ["items", "region"]


def test_values_that_are_not_strings_pass_through_without_a_log() -> None:
    with capture_logs() as logs:
        args = Args.model_validate({"region": {"x": 1, "y": 2}, "items": [3, 4]})

    assert (args.region, args.items) == (Region(x=1, y=2), [3, 4])
    assert logs == []


@pytest.mark.parametrize("region", ["x=1, y=2", "", "{"], ids=["plain", "empty", "truncated"])
def test_a_string_that_is_not_json_is_a_validation_error(region: str) -> None:
    """还原失败按普通校验错误退回模型，不吞掉也不伪造默认值。"""

    with pytest.raises(ValidationError):
        Args.model_validate({"region": region, "items": [1]})
