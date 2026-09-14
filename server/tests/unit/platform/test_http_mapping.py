"""领域错误 → HTTP 状态码单点映射，以及请求校验错误的信封文案。"""

from __future__ import annotations

from iclip.common.errors import (
    AuthenticationFailed,
    Conflict,
    DomainError,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from iclip.platform.http import status_code_for, validation_error_detail


def test_mapping_table() -> None:
    assert status_code_for(NotFound()) == 404
    assert status_code_for(PermissionDenied()) == 403
    assert status_code_for(Conflict()) == 409
    assert status_code_for(ValidationFailed()) == 422
    assert status_code_for(AuthenticationFailed()) == 401


def test_unknown_subclass_maps_to_500() -> None:
    class Weird(DomainError):
        pass

    assert status_code_for(Weird()) == 500


def test_subclass_inherits_parent_status() -> None:
    class SelfishAction(ValidationFailed):
        pass

    assert status_code_for(SelfishAction()) == 422


def test_detail_is_field_path_and_reason() -> None:
    """下标写成 ``[n]``、请求部位那一段不出现，自定义校验器的前缀去掉。"""

    errors = [
        {
            "type": "value_error",
            "loc": ("body", "shot", "timeline", 0, "image_indexes"),
            "msg": "Value error, 与正文里 @Image 的出现顺序不一致",
        }
    ]
    assert (
        validation_error_detail(errors)
        == "shot.timeline[0].image_indexes: 与正文里 @Image 的出现顺序不一致"
    )


def test_model_level_error_keeps_only_the_reason() -> None:
    """模型级校验器报在请求体自身，位置剥掉就空了，只留原因。"""

    errors = [
        {"type": "value_error", "loc": ("body",), "msg": "Value error, prompt 与 shot 至少传一个"}
    ]
    assert validation_error_detail(errors) == "prompt 与 shot 至少传一个"


def test_broken_json_does_not_render_a_character_offset() -> None:
    """正文不是 JSON 时位置的第二段是字符偏移，拼成字段路径只会误导。"""

    errors = [{"type": "json_invalid", "loc": ("body", 12), "msg": "JSON decode error"}]
    assert validation_error_detail(errors) == "JSON decode error"


def test_only_the_first_error_is_reported() -> None:
    errors = [
        {"type": "missing", "loc": ("body", "model"), "msg": "Field required"},
        {"type": "missing", "loc": ("body", "prompt"), "msg": "Field required"},
    ]
    assert validation_error_detail(errors) == "model: Field required"


def test_empty_errors_fall_back_to_a_sentence() -> None:
    assert validation_error_detail([]) == "请求格式无效"
