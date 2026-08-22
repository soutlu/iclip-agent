"""agent 装配声明的加载契约：缺失即报错、坏形状即拒、路径按目录约定解析。"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from iclip.config import load_agent_declarations

SPEC = "model: test\n"


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
    path = write_declaration(tmp_path, "agent:\n  storyboard:\n    spec: storyboard/agent.yaml\n")

    (declared,) = load_agent_declarations(path)

    assert declared.agent_id == "storyboard"
    assert declared.spec == (tmp_path / "storyboard" / "agent.yaml").resolve()
    assert declared.instructions == tmp_path / "storyboard" / "instructions.md"
    assert declared.subagents == ()


def test_instructions_absent_is_none(tmp_path: Path) -> None:
    make_agent_dir(tmp_path, "storyboard")
    path = write_declaration(tmp_path, "agent:\n  storyboard:\n    spec: storyboard/agent.yaml\n")

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
        "    subagent:\n"
        "      - spec: shot-writer/agent.yaml\n"
        "        timeout_seconds: 180\n"
        "        max_calls: 3\n"
        "        on_failure: 就此收手\n",
    )

    (declared,) = load_agent_declarations(path)
    (sub,) = declared.subagents

    assert sub.spec == (tmp_path / "shot-writer" / "agent.yaml").resolve()
    assert (sub.timeout_seconds, sub.max_calls, sub.on_failure) == (180.0, 3, "就此收手")


def test_unknown_key_rejected(tmp_path: Path) -> None:
    make_agent_dir(tmp_path, "storyboard")
    path = write_declaration(
        tmp_path,
        "agent:\n  storyboard:\n    spec: storyboard/agent.yaml\n    model: test\n",
    )
    with pytest.raises(ValidationError):
        load_agent_declarations(path)


def test_unknown_top_level_section_rejected(tmp_path: Path) -> None:
    path = write_declaration(tmp_path, "agent: {}\nrun_targets: {}\n")
    with pytest.raises(ValidationError):
        load_agent_declarations(path)


def test_missing_spec_file_fails_fast(tmp_path: Path) -> None:
    path = write_declaration(tmp_path, "agent:\n  storyboard:\n    spec: storyboard/agent.yaml\n")
    with pytest.raises(RuntimeError, match="spec 文件不存在"):
        load_agent_declarations(path)


def test_missing_subagent_spec_file_fails_fast(tmp_path: Path) -> None:
    make_agent_dir(tmp_path, "producer")
    path = write_declaration(
        tmp_path,
        "agent:\n"
        "  producer:\n"
        "    spec: producer/agent.yaml\n"
        "    subagent:\n"
        "      - spec: ghost/agent.yaml\n",
    )
    with pytest.raises(RuntimeError, match="subagent 声明的 spec 文件不存在"):
        load_agent_declarations(path)


def test_non_mapping_document_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="不是 mapping"):
        load_agent_declarations(write_declaration(tmp_path, "- a\n- b\n"))


def test_shipped_declaration_loads(tmp_path: Path) -> None:
    """仓内 agents/agents.yaml 必须可加载（当前为空注册表）。"""

    shipped = Path(__file__).resolve().parents[3] / "agents" / "agents.yaml"
    assert shipped.is_file()
    assert load_agent_declarations(shipped) == ()
