"""验证测试分层目录与命名规则。"""

from __future__ import annotations

import ast
from pathlib import Path

TESTS = Path(__file__).resolve().parents[2]
ALLOWED_TOP = {"unit", "integration_no_llm", "integration_llm", "e2e_full", "helpers"}

PRIVATE_IMPORT_BASELINE: frozenset[str] = frozenset()


def test_tree_layout() -> None:
    for path in TESTS.rglob("test_*.py"):
        rel = path.relative_to(TESTS)
        assert rel.parts[0] in ALLOWED_TOP - {"helpers"}, f"越位测试文件: {rel}"
    for path in (TESTS / "helpers").rglob("test_*.py"):
        raise AssertionError(f"helpers 不得包含 test_ 文件: {path.name}")
    for child in TESTS.iterdir():
        if child.is_dir() and child.name not in ALLOWED_TOP | {"__pycache__"}:
            raise AssertionError(f"未知测试层级目录: {child.name}")


def test_no_private_imports_from_src() -> None:
    violations: set[str] = set()
    for path in TESTS.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("iclip"):
                for alias in node.names:
                    if alias.name.startswith("_"):
                        violations.add(f"{path.relative_to(TESTS)}:{alias.name}")
    new = violations - PRIVATE_IMPORT_BASELINE
    stale = PRIVATE_IMPORT_BASELINE - violations
    assert not new, f"测试引入私有符号（禁止新增）: {sorted(new)}"
    assert not stale, f"棘轮基线过期，请删除: {sorted(stale)}"
