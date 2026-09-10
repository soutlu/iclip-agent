"""模型面工具入参的归一化，各能力包共用。"""

from __future__ import annotations

import json

import structlog
from pydantic import BeforeValidator, ValidationInfo

_logger = structlog.stdlib.get_logger(__name__)


def parse_json_text(value: object, info: ValidationInfo) -> object:
    """模型把对象或数组整体序列化成字符串时先还原再校验；不是字符串原样放行。

    解析失败抛出的 ValueError 由 pydantic 收成普通校验错误退回模型。"""

    if not isinstance(value, str):
        return value
    _logger.warning("工具参数以字符串传入，已解析", field=info.field_name)
    return json.loads(value)


JsonText = BeforeValidator(parse_json_text)
"""挂在对象或数组类型的工具入参上：模型有一定概率把它裹成一个 JSON 字符串传进来。"""
