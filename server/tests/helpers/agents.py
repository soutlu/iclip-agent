"""agent 声明工厂：在临时目录里放好 spec，返回装配用的 ResolvedAgent。"""

from __future__ import annotations

from pathlib import Path

from iclip.config import ResolvedAgent, SkillMount
from tests.helpers.app import TEST_MODEL_NAME


def spec_path(root: Path, name: str) -> Path:
    """在 ``root/name/`` 下放一个空 agent.yaml 并返回路径；身份来自声明，空 spec 就够用。"""

    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "agent.yaml"
    path.write_text("", encoding="utf-8")
    return path


def declared_agent(
    root: Path,
    agent_id: str,
    *,
    model: str = TEST_MODEL_NAME,
    skills: SkillMount | None = None,
    capabilities: tuple[str, ...] = (),
) -> ResolvedAgent:
    """没有指令、没有子代理的声明；展示名同 ``agent_id``。其余字段按需 ``dataclasses.replace``。"""

    return ResolvedAgent(
        agent_id=agent_id,
        name=agent_id,
        spec=spec_path(root, agent_id),
        instructions=None,
        model=model,
        skills=skills,
        capabilities=capabilities,
        subagents=(),
    )


__all__ = ["declared_agent", "spec_path"]
