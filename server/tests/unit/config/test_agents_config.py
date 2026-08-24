"""agent 装配声明的加载契约：缺失即报错、坏形状即拒、路径按目录约定解析。"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from iclip.config import load_agent_declarations

SPEC = "# 模型在 agents.yaml 里指定\n"
MODEL = "qwen"


def make_agent_dir(root: Path, name: str, *, instructions: str | None = None) -> None:
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "agent.yaml").write_text(SPEC, encoding="utf-8")
    if instructions is not None:
        (folder / "instructions.md").write_text(instructions, encoding="utf-8")


def write_declaration(root: Path, content: str) -> Path:
    path = root / "agents.yaml"
    path.write_text(content, encoding="utf-8")
    return path


def test_missing_file_fails_loudly(tmp_path: Path) -> None:
    """路径打错 / 部署漏目录不得降级成空注册表——那与「故意没配」无法区分。"""

    with pytest.raises(FileNotFoundError, match="agent 声明文件不存在"):
        load_agent_declarations(tmp_path / "nope.yaml")


def test_empty_file_yields_empty_registry(tmp_path: Path) -> None:
    """「没有 agent」由文件内容表达（存在但为空），不由文件缺席表达。"""

    assert load_agent_declarations(write_declaration(tmp_path, "")) == ()


def test_empty_agent_section_yields_empty_registry(tmp_path: Path) -> None:
    assert load_agent_declarations(write_declaration(tmp_path, "agent: {}\n")) == ()


def test_single_agent_resolves_spec_and_instructions(tmp_path: Path) -> None:
    make_agent_dir(tmp_path, "storyboard", instructions="写镜头表。")
    path = write_declaration(
        tmp_path, "agent:\n  storyboard:\n    spec: storyboard/agent.yaml\n    model: qwen\n"
    )

    (declared,) = load_agent_declarations(path)

    assert declared.agent_id == "storyboard"
    assert declared.spec == (tmp_path / "storyboard" / "agent.yaml").resolve()
    assert declared.instructions == tmp_path / "storyboard" / "instructions.md"
    assert declared.subagents == ()


def test_instructions_absent_is_none(tmp_path: Path) -> None:
    make_agent_dir(tmp_path, "storyboard")
    path = write_declaration(
        tmp_path, "agent:\n  storyboard:\n    spec: storyboard/agent.yaml\n    model: qwen\n"
    )

    (declared,) = load_agent_declarations(path)

    assert declared.instructions is None


def test_subagent_controls_parsed(tmp_path: Path) -> None:
    make_agent_dir(tmp_path, "producer")
    make_agent_dir(tmp_path, "shot-writer")
    path = write_declaration(
        tmp_path,
        "agent:\n"
        "  producer:\n"
        "    spec: producer/agent.yaml\n"
        "    model: qwen\n"
        "    subagent:\n"
        "      - spec: shot-writer/agent.yaml\n"
        "        model: local\n"
        "        timeout_seconds: 180\n"
        "        max_calls: 3\n"
        "        on_failure: 就此收手\n",
    )

    (declared,) = load_agent_declarations(path)
    (sub,) = declared.subagents

    assert sub.spec == (tmp_path / "shot-writer" / "agent.yaml").resolve()
    assert (declared.model, sub.model) == ("qwen", "local")  # 主从各自指定模型
    assert (sub.timeout_seconds, sub.max_calls, sub.on_failure) == (180.0, 3, "就此收手")


def test_skills_and_capabilities_resolve_per_agent(tmp_path: Path) -> None:
    """主从各挂各的：下属不继承主 agent 的 skill 与能力包。"""

    make_agent_dir(tmp_path, "producer")
    make_agent_dir(tmp_path, "shot-writer")
    (tmp_path / "skills" / "拆解素材").mkdir(parents=True)
    path = write_declaration(
        tmp_path,
        "agent:\n"
        "  producer:\n"
        "    spec: producer/agent.yaml\n"
        "    model: qwen\n"
        "    skills: [拆解素材]\n"
        "    capabilities: [video]\n"
        "    subagent:\n"
        "      - spec: shot-writer/agent.yaml\n"
        "        model: qwen\n"
        "        skills: [拆解素材]\n",
    )

    (declared,) = load_agent_declarations(path)
    (sub,) = declared.subagents

    assert declared.skills is not None
    assert declared.skills.library == (tmp_path / "skills").resolve()
    assert declared.skills.names == ("拆解素材",)
    assert declared.capabilities == ("video",)
    # 下属只有显式给它的那一样：挂了 skill，没挂能力包。
    assert sub.skills is not None and sub.skills.names == ("拆解素材",)
    assert sub.capabilities == ()


def test_no_skills_declared_mounts_nothing(tmp_path: Path) -> None:
    """写空列表和不写是同一件事：都不挂，也都不要求 skill 库存在。"""

    make_agent_dir(tmp_path, "storyboard")
    path = write_declaration(
        tmp_path,
        "agent:\n  storyboard:\n    spec: storyboard/agent.yaml\n    model: qwen\n    skills: []\n",
    )

    (declared,) = load_agent_declarations(path)

    assert declared.skills is None


def test_declared_skills_without_library_fails_loudly(tmp_path: Path) -> None:
    """声明要挂 skill 却没有库：部署漏目录必须报错，不能降级成没挂。"""

    make_agent_dir(tmp_path, "storyboard")
    path = write_declaration(
        tmp_path,
        "agent:\n"
        "  storyboard:\n"
        "    spec: storyboard/agent.yaml\n"
        "    model: qwen\n"
        "    skills: [拆解素材]\n",
    )

    with pytest.raises(RuntimeError, match="skill 库不存在"):
        load_agent_declarations(path)


def test_unknown_key_rejected(tmp_path: Path) -> None:
    make_agent_dir(tmp_path, "storyboard")
    path = write_declaration(
        tmp_path,
        "agent:\n  storyboard:\n    spec: storyboard/agent.yaml\n    model: qwen\n    retries: 3\n",
    )
    with pytest.raises(ValidationError):
        load_agent_declarations(path)


def test_unknown_top_level_section_rejected(tmp_path: Path) -> None:
    path = write_declaration(tmp_path, "agent: {}\nrun_targets: {}\n")
    with pytest.raises(ValidationError):
        load_agent_declarations(path)


def test_missing_spec_file_fails_fast(tmp_path: Path) -> None:
    path = write_declaration(
        tmp_path, "agent:\n  storyboard:\n    spec: storyboard/agent.yaml\n    model: qwen\n"
    )
    with pytest.raises(RuntimeError, match="spec 文件不存在"):
        load_agent_declarations(path)


def test_missing_subagent_spec_file_fails_fast(tmp_path: Path) -> None:
    make_agent_dir(tmp_path, "producer")
    path = write_declaration(
        tmp_path,
        "agent:\n"
        "  producer:\n"
        "    spec: producer/agent.yaml\n"
        "    model: qwen\n"
        "    subagent:\n"
        "      - spec: ghost/agent.yaml\n"
        "        model: qwen\n",
    )
    with pytest.raises(RuntimeError, match="subagent 声明的 spec 文件不存在"):
        load_agent_declarations(path)


def test_non_mapping_document_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="不是 mapping"):
        load_agent_declarations(write_declaration(tmp_path, "- a\n- b\n"))


def test_shipped_declaration_loads(tmp_path: Path) -> None:
    """仓内 agents/agents.yaml 必须可加载，且引用的 spec 与模型名都写了。"""

    shipped = Path(__file__).resolve().parents[3] / "agents" / "agents.yaml"
    declared = load_agent_declarations(shipped)
    assert [agent.agent_id for agent in declared] == ["assistant"]
    for agent in declared:
        assert agent.spec.is_file()
        assert agent.model


def test_agent_without_model_rejected(tmp_path: Path) -> None:
    """没有默认模型：漏写就拒收，不悄悄挑一个。"""

    make_agent_dir(tmp_path, "storyboard")
    path = write_declaration(tmp_path, "agent:\n  storyboard:\n    spec: storyboard/agent.yaml\n")
    with pytest.raises(ValidationError):
        load_agent_declarations(path)
