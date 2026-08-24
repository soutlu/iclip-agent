"""Agent 装配声明（``agents/agents.yaml``）的加载与路径解析。

与 ``config.yaml`` 分开的理由是变更节奏不同：那一份是运维配置（只存 ``*_env``
变量名），这一份是产品资产的装配声明。本模块只做加载、结构校验与路径解析——
把 ``spec`` 解析成绝对路径、按目录约定找出同级 ``instructions.md``，并在文件
缺失时立刻失败（启动期 fail fast）。

声明文件本身必须存在——路径打错、部署漏目录、文件被删都必须大声失败，而不是
降级成空注册表（那与「故意没配 agent」无法区分）。「没有 agent」由文件里的
``agent: {}`` 表达，不由文件缺席表达。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml
from pydantic import Field

from iclip.config.models import ConfigSection

INSTRUCTIONS_FILENAME = "instructions.md"
SKILLS_DIRNAME = "skills"
"""skill 库：声明文件同级的这个目录，一个子目录一个 skill。"""


class CapabilitySection(ConfigSection):
    """挂什么能力：从 skill 库里挑哪几个、挂哪几个业务能力包。

    两者都是「不写即不挂」。子 agent 也带这两个字段且不继承主 agent 的——
    下属只拥有显式给它的东西。
    """

    skills: tuple[str, ...] = ()
    packs: tuple[str, ...] = ()


class SubAgentSection(CapabilitySection):
    """一条派活关系。三个控制字段与官方 harness ``SubAgent`` 同名。"""

    spec: str
    model: str
    timeout_seconds: float | None = None
    max_calls: int | None = None
    on_failure: str | None = None


class AgentSection(CapabilitySection):
    """``model`` 引用 ``config.yaml`` 中 ``models`` 段的键名。"""

    spec: str
    model: str
    subagent: tuple[SubAgentSection, ...] = ()


class AgentsDeclaration(ConfigSection):
    agent: dict[str, AgentSection] = Field(default_factory=dict[str, AgentSection])


@dataclass(frozen=True, slots=True)
class SkillMount:
    """挂载哪个库里的哪几个 skill。库路径已解析成绝对路径。

    「不挂」由整个对象缺席表达（``None``），所以 ``names`` 恒非空——空列表和
    没写这个字段是同一件事，都不该造出一个空库挂载。
    """

    library: Path
    names: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ResolvedSubAgent:
    """一条已解析的派活关系。``name`` 取自 spec 所在目录名——与主 agent 同一条
    规矩：身份来自声明，不来自 spec 内容，所以空的 ``agent.yaml`` 也能用。"""

    name: str
    spec: Path
    instructions: Path | None
    model: str
    skills: SkillMount | None
    packs: tuple[str, ...]
    timeout_seconds: float | None
    max_calls: int | None
    on_failure: str | None


@dataclass(frozen=True, slots=True)
class ResolvedAgent:
    """一个已注册 agent 的装配事实；``agent_id`` 是唯一权威标识。"""

    agent_id: str
    spec: Path
    instructions: Path | None
    model: str
    skills: SkillMount | None
    packs: tuple[str, ...]
    subagents: tuple[ResolvedSubAgent, ...]


def _resolve_spec(base_dir: Path, spec: str, *, declared_by: str) -> tuple[Path, Path | None]:
    path = (base_dir / spec).resolve()
    if not path.is_file():
        raise RuntimeError(f"{declared_by} 声明的 spec 文件不存在: {path}")
    instructions = path.parent / INSTRUCTIONS_FILENAME
    return path, instructions if instructions.is_file() else None


def _resolve_skills(
    base_dir: Path, names: tuple[str, ...], *, declared_by: str
) -> SkillMount | None:
    """把 skill 名字列表解析成一次库挂载；没挑就是不挂。

    库路径在这里解析成绝对路径，不留给官方 ``Skills`` 按进程工作目录去猜——
    同一份代码在不同工作目录下行为不同且不报错，是最难查的那类问题。
    """

    if not names:
        return None
    library = (base_dir / SKILLS_DIRNAME).resolve()
    if not library.is_dir():
        raise RuntimeError(f"{declared_by} 声明了 skill，但 skill 库不存在: {library}")
    return SkillMount(library=library, names=names)


def _resolve_subagent(
    base_dir: Path, sub: SubAgentSection, *, declared_by: str
) -> ResolvedSubAgent:
    spec, instructions = _resolve_spec(base_dir, sub.spec, declared_by=declared_by)
    return ResolvedSubAgent(
        name=spec.parent.name,
        spec=spec,
        instructions=instructions,
        model=sub.model,
        skills=_resolve_skills(base_dir, sub.skills, declared_by=declared_by),
        packs=sub.packs,
        timeout_seconds=sub.timeout_seconds,
        max_calls=sub.max_calls,
        on_failure=sub.on_failure,
    )


def load_agent_declarations(path: Path) -> tuple[ResolvedAgent, ...]:
    """加载并解析 agent 声明；``agent`` 段为空即空注册表，文件缺失即报错。"""

    if not path.is_file():
        raise FileNotFoundError(
            f"agent 声明文件不存在: {path}（没有 agent 请在文件里写 agent: {{}}）"
        )
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if raw is None:
        return ()
    if not isinstance(raw, dict):
        raise ValueError(f"agent 声明文件不是 mapping: {path}")
    declaration = AgentsDeclaration.model_validate(raw)

    base_dir = path.parent
    resolved: list[ResolvedAgent] = []
    for agent_id, section in declaration.agent.items():
        spec, instructions = _resolve_spec(base_dir, section.spec, declared_by=f"agent.{agent_id}")
        resolved.append(
            ResolvedAgent(
                agent_id=agent_id,
                spec=spec,
                instructions=instructions,
                model=section.model,
                skills=_resolve_skills(base_dir, section.skills, declared_by=f"agent.{agent_id}"),
                packs=section.packs,
                subagents=tuple(
                    _resolve_subagent(base_dir, sub, declared_by=f"agent.{agent_id}.subagent")
                    for sub in section.subagent
                ),
            )
        )
    return tuple(resolved)


__all__ = [
    "INSTRUCTIONS_FILENAME",
    "SKILLS_DIRNAME",
    "AgentSection",
    "AgentsDeclaration",
    "CapabilitySection",
    "ResolvedAgent",
    "ResolvedSubAgent",
    "SkillMount",
    "SubAgentSection",
    "load_agent_declarations",
]
