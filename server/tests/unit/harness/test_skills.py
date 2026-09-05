"""验证 skill 装配与 references 访问边界。

通过真实 Agent 调用工具，覆盖工具名称与校验器挂载；中文 skill 名覆盖目录命名规则。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from pydantic_ai import Agent
from pydantic_ai.capabilities import AgentCapability, Capability
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.tools import Tool
from pydantic_ai_harness.skills import Skills

from iclip.harness.skills import (
    MAX_REFERENCE_CHARS,
    TRUNCATION_MARKER,
    build_skill_capabilities,
    skill_display_table,
)
from iclip.platform.transcript.display import SkillCallDisplay

SKILL = "拆解素材"
OTHER = "镜头表"
TOOL = "get_skill_reference"


def make_skill(library: Path, name: str, *, references: dict[str, str] | None = None) -> None:
    folder = library / name
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: 测试用 skill\n---\n\n照着 {name} 做。\n",
        encoding="utf-8",
    )
    for filename, body in (references or {}).items():
        target = folder / "references" / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")


async def read_reference(
    library: Path, names: tuple[str, ...], *, skill: str, name: str
) -> ToolReturnPart | RetryPromptPart:
    """通过 Agent 调用 get_skill_reference，以 ToolReturnPart 和 RetryPromptPart 区分成功与可重试拒绝。"""

    async def call_once(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(TOOL, {"skill": skill, "name": name})])
        return ModelResponse(parts=[TextPart("读完了")])

    agent = Agent(
        FunctionModel(call_once),
        capabilities=list(build_skill_capabilities(library, names)),
    )
    result = await agent.run("读一份 reference")
    parts = [
        part
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, ToolReturnPart | RetryPromptPart) and part.tool_name == TOOL
    ]
    assert len(parts) == 1  # 单次调用必须仅有一个结果，以检测工具重复注册。
    return parts[0]


async def tool_names(capabilities: list[AgentCapability[Any]]) -> tuple[str, ...]:

    seen: tuple[str, ...] = ()

    async def peek(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        nonlocal seen
        seen = tuple(tool.name for tool in info.function_tools)
        return ModelResponse(parts=[TextPart("看完了")])

    await Agent(FunctionModel(peek), capabilities=capabilities).run("有哪些工具")
    return seen


async def test_reference_tool_comes_only_with_a_skill_library(tmp_path: Path) -> None:

    make_skill(tmp_path, SKILL)

    assert await tool_names([]) == ()
    assert await tool_names(list(build_skill_capabilities(tmp_path, (SKILL,)))) == (
        "load_capability",
        TOOL,
    )


def test_unknown_skill_name_fails_at_assembly(tmp_path: Path) -> None:

    make_skill(tmp_path, SKILL)
    with pytest.raises(ValueError, match="没这个"):
        build_skill_capabilities(tmp_path, ("没这个",))


def test_mounting_zero_skills_is_a_caller_error(tmp_path: Path) -> None:

    make_skill(tmp_path, SKILL)
    with pytest.raises(ValueError, match="至少要挑一个 skill"):
        build_skill_capabilities(tmp_path, ())


def test_library_and_reference_key_are_mounted_together(tmp_path: Path) -> None:

    make_skill(tmp_path, SKILL)

    skills, key = build_skill_capabilities(tmp_path, (SKILL,))

    assert isinstance(skills, Skills)
    assert isinstance(key, Capability)


def test_the_access_boundary_is_mounted_as_a_validator(tmp_path: Path) -> None:
    """需检查注册表的 args_validator，避免未授权 skill 的 references 因漏挂校验器而可读。"""

    make_skill(tmp_path, SKILL)
    _, key = build_skill_capabilities(tmp_path, (SKILL,))
    assert isinstance(key, Capability)

    tool = next(iter(key.tools))
    assert isinstance(tool, Tool)
    assert tool.name == TOOL
    assert tool.args_validator is not None


def test_the_reference_tool_has_a_display(tmp_path: Path) -> None:

    drawn = skill_display_table()[TOOL]

    assert drawn({"skill": SKILL, "name": "规范.md"}) == SkillCallDisplay(
        skill_name=SKILL, args="规范.md"
    )
    assert drawn({"skill": SKILL}) == SkillCallDisplay(skill_name=SKILL, args=None)
    assert drawn({}) is None


async def test_granted_skill_reference_is_readable(tmp_path: Path) -> None:
    make_skill(tmp_path, SKILL, references={"规范.md": "规范正文"})

    part = await read_reference(tmp_path, (SKILL,), skill=SKILL, name="规范.md")

    assert isinstance(part, ToolReturnPart)
    assert part.content == "规范正文"


async def test_ungranted_skill_references_are_refused(tmp_path: Path) -> None:

    make_skill(tmp_path, SKILL)
    make_skill(tmp_path, OTHER, references={"规范.md": "别人的正文"})

    part = await read_reference(tmp_path, (SKILL,), skill=OTHER, name="规范.md")

    assert isinstance(part, RetryPromptPart)
    assert "没有挂载 skill" in part.model_response()


@pytest.mark.parametrize(
    "name",
    ["../../etc/passwd", "../镜头表/references/规范.md", "/etc/passwd", "规范.txt", "不存在.md"],
)
async def test_reference_paths_outside_the_skill_are_refused(tmp_path: Path, name: str) -> None:

    make_skill(tmp_path, SKILL, references={"规范.md": "正文"})
    make_skill(tmp_path, OTHER, references={"规范.md": "别人的正文"})

    part = await read_reference(tmp_path, (SKILL, OTHER), skill=SKILL, name=name)

    assert isinstance(part, RetryPromptPart)


async def test_refusal_lists_the_available_references(tmp_path: Path) -> None:
    """拒绝时列出可访问文件，包含子目录，以便模型修正路径。"""

    make_skill(
        tmp_path,
        SKILL,
        references={"规范.md": "正文", "补充.md": "正文", "深处/细则.md": "正文"},
    )

    part = await read_reference(tmp_path, (SKILL,), skill=SKILL, name="规范表.md")

    assert isinstance(part, RetryPromptPart)
    # 顺序按码位排，稳定即可
    assert "它有: 深处/细则.md, 补充.md, 规范.md" in part.model_response()


async def test_nested_reference_is_readable(tmp_path: Path) -> None:
    make_skill(tmp_path, SKILL, references={"深处/细则.md": "细则正文"})

    part = await read_reference(tmp_path, (SKILL,), skill=SKILL, name="深处/细则.md")

    assert isinstance(part, ToolReturnPart)
    assert part.content == "细则正文"


async def test_overlong_reference_is_truncated_loudly(tmp_path: Path) -> None:

    make_skill(tmp_path, SKILL, references={"长文.md": "甲" * (MAX_REFERENCE_CHARS + 10)})

    part = await read_reference(tmp_path, (SKILL,), skill=SKILL, name="长文.md")

    assert isinstance(part, ToolReturnPart)
    text = part.content
    assert isinstance(text, str)
    assert text.endswith(TRUNCATION_MARKER)
    assert len(text) == MAX_REFERENCE_CHARS + len(TRUNCATION_MARKER)


async def test_broken_encoding_aborts_instead_of_retrying(tmp_path: Path) -> None:
    """引用文件编码损坏属于部署资产故障，模型重试无法修复。"""

    make_skill(tmp_path, SKILL)
    (tmp_path / SKILL / "references").mkdir()
    (tmp_path / SKILL / "references" / "坏.md").write_bytes(b"\xff\xfe\x00\x01")

    with pytest.raises(UnicodeDecodeError):
        await read_reference(tmp_path, (SKILL,), skill=SKILL, name="坏.md")
