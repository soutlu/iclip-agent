"""skill 库的装配：按需加载的流程指令，加一把读 references 的钥匙。

一个 skill 就是库里的一个子目录：``SKILL.md`` 的简介先进模型视野，正文等它
真觉得用得上才加载。正文旁边常放 ``references/``——那是刻意拆出去的分支规则
（比如三种改编模式各一份，只该读命中的那一份），所以它们不能并进正文。

官方 ``Skills`` 只读 ``SKILL.md``，不碰 ``references/``。库里放着分支规则而
没有读它的工具，模型会照着正文里的指示去读、然后发现无从下手——这种静默失效
比报错更难查。所以这里把两者绑成一次装配：**要挂库就一起挂钥匙**。
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from pydantic_ai import ModelRetry
from pydantic_ai.capabilities import AgentCapability, Capability
from pydantic_ai_harness.skills import Skills

REFERENCES_DIRNAME = "references"
"""skill 目录下存放分支规则的子目录名。"""

MAX_REFERENCE_CHARS = 40_000
"""单次读取上限。超了截断并显式标注——不能悄悄少给一段。"""

TRUNCATION_MARKER = "\n\n[... 已截断，超出单次读取上限 ...]"


def build_skill_capabilities(
    library: Path, names: Sequence[str]
) -> tuple[AgentCapability[Any], ...]:
    """挂一批 skill：按需加载的指令 + 只能读这批 skill 的 references 的工具。

    ``names`` 里有库里不存在的名字，官方 ``Skills`` 在这里就报错（装配期
    fail fast，而不是等模型去点一个不存在的 skill）。

    一个都不挑是调用方的错，不是「挂一个空的」：那样装出来的是一份空目录加一
    把开不了任何门的钥匙，agent 白拿一个工具。「不挂」由根本不调用本函数表达。
    """

    granted = tuple(names)
    if not granted:
        raise ValueError("build_skill_capabilities 至少要挑一个 skill；不挂就别调它。")
    return (Skills(library, include=granted), _references_capability(library, granted))


def _references_capability(library: Path, granted: tuple[str, ...]) -> Capability[Any]:
    """把读 references 的钥匙做成一个工具。

    它跟着 skill 库一起挂：没挂库的 agent 连这个工具都没有。但在挂了库的 agent
    里它从第一轮就可见，不像 skill 正文那样等模型点了才加载——官方 ``Skills``
    在内部自造 deferred capability，插不进去一个工具。这点噪音换的是「加载了
    skill 就一定读得到它的分支规则」。
    """

    def get_skill_reference(skill: str, name: str) -> str:
        """读取某个 skill 的一份 reference 文档。

        Args:
            skill: skill 名，即它在库里的目录名。
            name: reference 文件名（如 ``storyboard-spec.md``），不带目录前缀。
        """

        if skill not in granted:
            # include/exclude 是「模型看得见哪些 skill」，不是访问边界（官方
            # 文档明说了）。真正的边界只能落在这里：没挂给这个 agent 的 skill，
            # 它的 references 也不该读得到。
            raise ModelRetry(f"没有挂载 skill {skill!r}。可读的是: {', '.join(granted)}。")
        if Path(name).suffix != ".md":
            raise ModelRetry(f"reference 只能是 .md 文档，收到 {name!r}。")
        root = (library / skill / REFERENCES_DIRNAME).resolve()
        target = (root / name).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            # 越界（``..``、绝对路径、软链接）与不存在合报一句：模型该做的动作
            # 都是换个文件名重试，不需要知道自己踩的是哪一种。顺手把有哪些文件
            # 报回去——让它改得动，而不是接着猜（正文里写错一个文件名很常见）。
            #
            # 递归列举并给出相对路径：子目录里的 reference 上面那两个条件同样放
            # 行，所以「列出来的」必须和「读得到的」是同一批，否则模型会以为某
            # 份文档不存在。
            available = (
                sorted(str(item.relative_to(root)) for item in root.rglob("*.md"))
                if root.is_dir()
                else []
            )
            raise ModelRetry(
                f"skill {skill!r} 下没有 reference {name!r}。"
                + (f"它有: {', '.join(available)}。" if available else "它没有任何 reference。")
            )
        # 自家资产读不出字符（编码坏了）是环境故障，让它炸出来——重试改不了
        # 坏文件，只会让模型在这儿打转。
        text = target.read_text(encoding="utf-8")
        if len(text) > MAX_REFERENCE_CHARS:
            return text[:MAX_REFERENCE_CHARS] + TRUNCATION_MARKER
        return text

    return Capability[Any](id="skill-references", tools=[get_skill_reference])


__all__ = [
    "MAX_REFERENCE_CHARS",
    "REFERENCES_DIRNAME",
    "TRUNCATION_MARKER",
    "build_skill_capabilities",
]
