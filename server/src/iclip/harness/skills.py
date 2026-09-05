"""装配按需加载的 skill 指令与 reference 读取工具。

官方 Skills 仅加载 SKILL.md；references 保持独立，由配套工具按需读取。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic_ai import ModelRetry
from pydantic_ai.capabilities import AgentCapability, Capability
from pydantic_ai.tools import RunContext, Tool
from pydantic_ai_harness.skills import Skills

from iclip.platform.transcript.display import DisplayFn, SkillCallDisplay, ToolDisplay

REFERENCES_DIRNAME = "references"
"""skill 目录下存放分支规则的子目录名。"""

MAX_REFERENCE_CHARS = 40_000
"""单次读取字符上限，截断时显式标注。"""

TRUNCATION_MARKER = "\n\n[... 已截断，超出单次读取上限 ...]"


def build_skill_capabilities(
    library: Path, names: Sequence[str]
) -> tuple[AgentCapability[Any], ...]:
    """装配指定 skill 及受限的 reference 读取工具；空列表或未知名称在装配时抛错。"""

    granted = tuple(names)
    if not granted:
        raise ValueError("build_skill_capabilities 至少要挑一个 skill；不挂就别调它。")
    return (Skills(library, include=granted), _references_capability(library, granted))


def _references_capability(library: Path, granted: tuple[str, ...]) -> Capability[Any]:
    """随 skill 库注册 reference 工具，从首轮即可调用；skill 正文仍按需加载。"""

    def validate_reference(ctx: RunContext[Any], skill: str, name: str) -> None:
        """校验 skill 已授权且 reference 为 Markdown；参数签名须与工具一致，前置 ctx。"""

        _ = ctx
        if skill not in granted:
            # Skills 的 include/exclude 仅控制模型可见性，reference 访问授权在此校验。
            raise ModelRetry(f"没有挂载 skill {skill!r}。可读的是: {', '.join(granted)}。")
        if Path(name).suffix != ".md":
            raise ModelRetry(f"reference 只能是 .md 文档，收到 {name!r}。")

    def get_skill_reference(skill: str, name: str) -> str:
        """读取某个 skill 的一份 reference 文档。

        Args:
            skill: skill 名，即它在库里的目录名。
            name: reference 文件名（如 ``storyboard-spec.md``），不带目录前缀。
        """

        root = (library / skill / REFERENCES_DIRNAME).resolve()
        target = (root / name).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            # 越界和不存在均返回可用文件列表，供模型修正参数。
            # 递归列出的相对路径须与允许读取的文件集合一致。
            available = (
                sorted(str(item.relative_to(root)) for item in root.rglob("*.md"))
                if root.is_dir()
                else []
            )
            raise ModelRetry(
                f"skill {skill!r} 下没有 reference {name!r}。"
                + (f"它有: {', '.join(available)}。" if available else "它没有任何 reference。")
            )
        # 编码错误属于资产故障，直接抛出，避免模型无效重试。
        text = target.read_text(encoding="utf-8")
        if len(text) > MAX_REFERENCE_CHARS:
            return text[:MAX_REFERENCE_CHARS] + TRUNCATION_MARKER
        return text

    return Capability[Any](
        id="skill-references",
        tools=[Tool(get_skill_reference, args_validator=validate_reference)],
    )


def skill_display_table() -> Mapping[str, DisplayFn]:
    """与 skill 工具同时注册的 reference 卡片格式。"""

    return {"get_skill_reference": _reference_display}


def _reference_display(args: Any) -> ToolDisplay | None:
    if not isinstance(args, dict):
        return None
    skill = args.get("skill")
    name = args.get("name")
    if not isinstance(skill, str) or not skill:
        return None
    return SkillCallDisplay(skill_name=skill, args=name if isinstance(name, str) else None)


__all__ = [
    "MAX_REFERENCE_CHARS",
    "REFERENCES_DIRNAME",
    "TRUNCATION_MARKER",
    "build_skill_capabilities",
    "skill_display_table",
]
