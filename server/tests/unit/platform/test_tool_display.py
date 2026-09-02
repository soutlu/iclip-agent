"""工具卡的画法注册表：查表、退回 generic、合表。

画法由能力包登记，这一层只管「查得到就用它、查不到就画朴素的那张」，以及装配期把各能力的表
合成一份。合表撞名不报错的话，一件工具的画法会被另一个能力悄悄顶掉。
"""

from __future__ import annotations

from typing import Any

import pytest

from iclip.platform.transcript.display import (
    FileIoDisplay,
    GenericDisplay,
    SkillCallDisplay,
    ToolDisplay,
    ToolDisplayRegistry,
)


def _read(args: Any) -> ToolDisplay | None:
    path = args.get("path") if isinstance(args, dict) else None
    return FileIoDisplay(operation="read", path=path) if isinstance(path, str) and path else None


REGISTRY = ToolDisplayRegistry.merged({"read_file": _read})


def test_an_unregistered_tool_falls_back_to_generic() -> None:
    """表可以慢慢补：没登记的工具画成一张朴素的卡，卡上写它的名字。"""

    assert REGISTRY.tool_display("write_file", {"path": "a.md"}) == GenericDisplay(
        summary="write_file"
    )


def test_a_table_that_cannot_work_it_out_falls_back_to_generic() -> None:
    """登记了但这次算不出来（缺字段）也退回 generic，不抛异常——画卡不该拖垮一轮。"""

    assert REGISTRY.tool_display("read_file", {}) == GenericDisplay(summary="read_file")


def test_json_string_arguments_are_parsed() -> None:
    """消息里的工具参数可能是模型逐字发出来的 JSON 字串，不是 dict。"""

    assert REGISTRY.tool_display("read_file", '{"path": "shots.md"}') == FileIoDisplay(
        operation="read", path="shots.md"
    )


def test_unparseable_arguments_fall_back_to_generic() -> None:
    """半截的 JSON 按「这次没有参数」处理。"""

    assert REGISTRY.tool_display("read_file", '{"path": ') == GenericDisplay(summary="read_file")


def test_merging_two_tables_with_the_same_tool_fails_at_assembly() -> None:
    """一件工具只归一个能力：撞名不拦的话，它的画法会被另一张表悄悄顶掉。"""

    with pytest.raises(ValueError, match="read_file"):
        ToolDisplayRegistry.merged({"read_file": _read}, {"read_file": _read})


def test_the_empty_registry_draws_everything_generic() -> None:
    """测试 helper 用的那一份。生产的两条路都要收到真的注册表。"""

    assert ToolDisplayRegistry.EMPTY.tool_display("read_file", {"path": "a.md"}) == GenericDisplay(
        summary="read_file"
    )


def test_display_fields_follow_the_kimi_contract() -> None:
    """display 的字段名照 kimi 的 ``display.ts``（snake_case）：客户端按那份合同解析，不是按协议帧的 camelCase。"""

    dumped = SkillCallDisplay(skill_name="拆解素材", args="规范.md").model_dump(by_alias=True)
    assert dumped == {"kind": "skill_call", "skill_name": "拆解素材", "args": "规范.md"}
