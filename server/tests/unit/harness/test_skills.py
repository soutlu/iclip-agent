"""skill 库的装配契约与 references 的访问边界。

工具一律经真的 ``Agent`` 调用（官方 ``FunctionModel`` 派发工具调用，断言落在
消息历史上），不去直接调 capability 里的那个闭包——那样测不到它是否真以
``get_skill_reference`` 这个名字注册上了，而 SKILL.md 正文里写的就是这个名字。

skill 名故意用中文：目录名规则判的是「小写 + isalnum」，中文两条都过，而这套
资产就是中文的——用 ASCII 名测等于没测这条路径。
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
from pydantic_ai_harness.skills import Skills

from iclip.harness.skills import (
    MAX_REFERENCE_CHARS,
    TRUNCATION_MARKER,
    build_skill_capabilities,
)

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
    """让 agent 真调一次 ``get_skill_reference``，返回工具那一步的结果。

    成功是 ``ToolReturnPart``，被拒（``ModelRetry``）是 ``RetryPromptPart``——
    「让模型换个文件名重试」和「中止整次运行」的区别，在消息历史上就是这两种
    part 的区别。
    """

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
    assert len(parts) == 1  # 一次调用一个结果，多了说明工具被重复注册
    return parts[0]


async def tool_names(capabilities: list[AgentCapability[Any]]) -> tuple[str, ...]:
    """这套能力装出来的 agent，模型能看到哪些工具。"""

    seen: tuple[str, ...] = ()

    async def peek(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        nonlocal seen
        seen = tuple(tool.name for tool in info.function_tools)
        return ModelResponse(parts=[TextPart("看完了")])

    await Agent(FunctionModel(peek), capabilities=capabilities).run("有哪些工具")
    return seen


async def test_reference_tool_comes_only_with_a_skill_library(tmp_path: Path) -> None:
    """工具跟着 skill 库来，不跟着 agent 来：没挂 skill 的 agent 不该有它。

    它不是基础装配的一部分——每个 agent 都白拿一个读不到任何东西的工具，是纯
    噪音。挂了库才有，且此时官方的 load_capability（按需加载 skill 正文用的）
    一并出现。
    """

    make_skill(tmp_path, SKILL)

    assert await tool_names([]) == ()
    assert await tool_names(list(build_skill_capabilities(tmp_path, (SKILL,)))) == (
        "load_capability",
        TOOL,
    )


def test_unknown_skill_name_fails_at_assembly(tmp_path: Path) -> None:
    """挑了库里没有的 skill：装配期就报错，不留到模型去点一个不存在的东西。"""

    make_skill(tmp_path, SKILL)
    with pytest.raises(ValueError, match="没这个"):
        build_skill_capabilities(tmp_path, ("没这个",))


def test_mounting_zero_skills_is_a_caller_error(tmp_path: Path) -> None:
    """一个都不挑不是「挂一个空的」：那会装出一把开不了任何门的钥匙。"""

    make_skill(tmp_path, SKILL)
    with pytest.raises(ValueError, match="至少要挑一个 skill"):
        build_skill_capabilities(tmp_path, ())


def test_library_and_reference_key_are_mounted_together(tmp_path: Path) -> None:
    """有库就一定有读 references 的手段，否则模型会照着正文去读、然后无从下手。"""

    make_skill(tmp_path, SKILL)

    skills, key = build_skill_capabilities(tmp_path, (SKILL,))

    assert isinstance(skills, Skills)
    assert isinstance(key, Capability)


async def test_granted_skill_reference_is_readable(tmp_path: Path) -> None:
    make_skill(tmp_path, SKILL, references={"规范.md": "规范正文"})

    part = await read_reference(tmp_path, (SKILL,), skill=SKILL, name="规范.md")

    assert isinstance(part, ToolReturnPart)
    assert part.content == "规范正文"


async def test_ungranted_skill_references_are_refused(tmp_path: Path) -> None:
    """include 只管「模型看得见哪些 skill」，访问边界在这把钥匙上。"""

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
    """越界、非 .md、不存在都让模型换个文件名重试，而不是中止整次运行。"""

    make_skill(tmp_path, SKILL, references={"规范.md": "正文"})
    make_skill(tmp_path, OTHER, references={"规范.md": "别人的正文"})

    part = await read_reference(tmp_path, (SKILL, OTHER), skill=SKILL, name=name)

    assert isinstance(part, RetryPromptPart)


async def test_refusal_lists_the_available_references(tmp_path: Path) -> None:
    """文件名写错很常见：拒绝时把有哪些文件报回去，让模型改得动而不是接着猜。

    子目录里的也要列——它们同样读得到，「列出来的」必须和「读得到的」是同一批。
    """

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
    """超上限只能截断 + 明示，绝不能悄悄少给一段。"""

    make_skill(tmp_path, SKILL, references={"长文.md": "甲" * (MAX_REFERENCE_CHARS + 10)})

    part = await read_reference(tmp_path, (SKILL,), skill=SKILL, name="长文.md")

    assert isinstance(part, ToolReturnPart)
    text = part.content
    assert isinstance(text, str)
    assert text.endswith(TRUNCATION_MARKER)
    assert len(text) == MAX_REFERENCE_CHARS + len(TRUNCATION_MARKER)


async def test_broken_encoding_aborts_instead_of_retrying(tmp_path: Path) -> None:
    """自家资产读不出字符是环境故障：重试改不了坏文件，只会让模型打转。"""

    make_skill(tmp_path, SKILL)
    (tmp_path / SKILL / "references").mkdir()
    (tmp_path / SKILL / "references" / "坏.md").write_bytes(b"\xff\xfe\x00\x01")

    with pytest.raises(UnicodeDecodeError):
        await read_reference(tmp_path, (SKILL,), skill=SKILL, name="坏.md")
