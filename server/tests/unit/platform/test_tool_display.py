"""验证工具 display 注册、generic 回退及重复名称检测。"""

from __future__ import annotations

from typing import Any

import pytest

from iclip.platform.transcript.display import (
    FileIoDisplay,
    GenericDisplay,
    SkillCallDisplay,
    ToolDisplay,
    ToolDisplayEntry,
    ToolDisplayRegistry,
    diff_note,
    media_grid,
    tool_note,
    url_filename,
)


def _read(args: Any) -> ToolDisplay | None:
    path = args.get("path") if isinstance(args, dict) else None
    return FileIoDisplay(operation="read", path=path) if isinstance(path, str) and path else None


REGISTRY = ToolDisplayRegistry.merged({"read_file": _read})


def test_an_unregistered_tool_falls_back_to_generic() -> None:

    assert REGISTRY.tool_display("write_file", {"path": "a.md"}) == GenericDisplay(
        summary="write_file"
    )


def test_a_table_that_cannot_work_it_out_falls_back_to_generic() -> None:

    assert REGISTRY.tool_display("read_file", {}) == GenericDisplay(summary="read_file")


def test_json_string_arguments_are_parsed() -> None:
    """流式消息中的工具参数可能为 JSON 字符串，需要解析。"""

    assert REGISTRY.tool_display("read_file", '{"path": "shots.md"}') == FileIoDisplay(
        operation="read", path="shots.md"
    )


def test_unparseable_arguments_fall_back_to_generic() -> None:

    assert REGISTRY.tool_display("read_file", '{"path": ') == GenericDisplay(summary="read_file")


def test_merging_two_tables_with_the_same_tool_fails_at_assembly() -> None:

    with pytest.raises(ValueError, match="read_file"):
        ToolDisplayRegistry.merged({"read_file": _read}, {"read_file": _read})


def test_the_empty_registry_draws_everything_generic() -> None:

    assert ToolDisplayRegistry.EMPTY.tool_display("read_file", {"path": "a.md"}) == GenericDisplay(
        summary="read_file"
    )


def test_a_bare_drawing_function_becomes_an_entry_without_a_renderer() -> None:

    assert REGISTRY.entries["read_file"] == ToolDisplayEntry(draw=_read, view=None)
    assert REGISTRY.view_of("read_file") is None


def test_the_registered_renderer_is_looked_up_by_tool_name() -> None:

    registry = ToolDisplayRegistry.merged(
        {"read_file": ToolDisplayEntry(draw=_read, view="file_content")}
    )

    assert registry.view_of("read_file") == "file_content"
    assert registry.view_of("write_file") is None


def test_display_fields_follow_the_kimi_contract() -> None:
    """display 使用 snake_case，与协议帧的 camelCase 不同。"""

    dumped = SkillCallDisplay(skill_name="拆解素材", args="规范.md").model_dump(by_alias=True)
    assert dumped == {"kind": "skill_call", "skill_name": "拆解素材", "args": "规范.md"}


def test_generic_display_keeps_title_and_subject_apart() -> None:

    dumped = GenericDisplay(summary="删除文件", detail="分镜.md").model_dump(exclude_none=True)
    assert dumped == {"kind": "generic", "summary": "删除文件", "detail": "分镜.md"}
    assert GenericDisplay(summary="生成设定图").model_dump(exclude_none=True) == {
        "kind": "generic",
        "summary": "生成设定图",
    }


@pytest.mark.parametrize(
    ("url", "name"),
    [
        ("https://cdn.test/a/ref.mp4", "ref.mp4"),
        ("https://cdn.test/a/%E5%A4%9C%E6%99%AF.png?x-oss-process=image", "夜景.png"),
        ("https://cdn.test/", None),
        ("https://cdn.test", None),
    ],
)
def test_the_subject_of_a_url_is_its_file_name(url: str, name: str | None) -> None:

    assert url_filename(url) == name


def test_notes_only_carry_what_was_given() -> None:

    assert tool_note() == {}
    assert tool_note("4.2 KB") == {"chip": "4.2 KB"}
    assert tool_note(body="none") == {"body": "none"}
    assert diff_note(3, 1) == {"added": 3, "removed": 1}
    assert media_grid([("https://cdn.test/a.png", "S1-1")]) == {
        "items": [{"url": "https://cdn.test/a.png", "caption": "S1-1"}]
    }
    assert media_grid([], note="0 张") == {"items": [], "note": "0 张"}
