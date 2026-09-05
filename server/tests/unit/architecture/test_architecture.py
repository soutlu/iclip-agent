"""验证 tach 依赖图之外的框架引用、模块纯度和异常处理约束。"""

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[3] / "src" / "iclip"

# 框架及允许直接导入它的路径前缀（相对 src/iclip）。
FRAMEWORK_FENCES: dict[tuple[str, ...], tuple[str, ...]] = {
    ("pydantic_ai",): ("harness/", "capabilities/"),
    ("pydantic_ai_harness",): ("harness/",),
    ("fastapi", "starlette"): (
        "app/",
        "domains/identity/api.py",
        "domains/agents/api.py",
        "domains/agents/transcript_api.py",
        "domains/conversations/api.py",
        "domains/generation/api.py",
        "domains/products/api.py",
        "domains/inspirations/api.py",
        "domains/collections/api.py",
        "domains/tasks/api.py",
        "domains/assets/api.py",
        "domains/identity/middleware.py",
        "domains/identity/accounts.py",
        "main.py",
    ),
    ("sqlalchemy",): (
        "platform/db/",
        "platform/file_store/",
        "platform/material_ledger/",
        "app/",
        # StepPersistence 协议后端归属使用该协议的 harness。
        "harness/step_store_pg.py",
        # prompt 队列归属运行驱动，使用 agent_runtime schema。
        "harness/jobs.py",
        # 外部只读表使用独立适配器；infra_sql.py 仅表示模块自有表。
        "domains/products/catalog_pg.py",
        "domains/inspirations/catalog_pg.py",
    ),
    ("fastapi_users", "fastapi_users_db_sqlalchemy"): ("domains/identity/",),
    ("openai",): ("harness/models.py",),
    ("oss2",): ("platform/object_store/",),
    ("PIL",): ("capabilities/shot_video/board.py", "domains/assets/images.py"),
    # 队列实现、连接器类型与组合根需要直接引用 procrastinate。
    ("procrastinate",): (
        "domains/generation/queue.py",
        "domains/generation/module.py",
        "app/",
    ),
}
# 模块自有 SQL 按 infra_sql.py 文件名匹配。
_SQLALCHEMY_MODULE_FILE = "infra_sql.py"
_SQLALCHEMY_MODULE_PREFIXES = ("domains/", "capabilities/")


def _python_files() -> list[Path]:
    return sorted(SRC.rglob("*.py"))


def _imported_top_levels(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module.split(".")[0])
    return found


def _rel(path: Path) -> str:
    return path.relative_to(SRC).as_posix()


def test_framework_fences() -> None:
    violations: list[str] = []
    for path in _python_files():
        rel = _rel(path)
        imports = _imported_top_levels(path)
        for frameworks, allowed in FRAMEWORK_FENCES.items():
            hit = imports & set(frameworks)
            if not hit:
                continue
            if (
                frameworks == ("sqlalchemy",)
                and rel.startswith(_SQLALCHEMY_MODULE_PREFIXES)
                and path.name == _SQLALCHEMY_MODULE_FILE
            ):
                continue
            if not any(rel == prefix or rel.startswith(prefix) for prefix in allowed):
                violations.append(f"{rel}: 越界 import {sorted(hit)}")
    assert not violations, "框架围栏违规:\n" + "\n".join(violations)


def test_cross_module_imports_only_public() -> None:

    violations: list[str] = []
    domains = [p.name for p in (SRC / "domains").iterdir() if p.is_dir()]
    for root_name, has_own in (("domains", True), ("capabilities", False)):
        for path in (SRC / root_name).rglob("*.py"):
            rel = _rel(path)
            own = rel.split("/")[1] if has_own else None
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom) or not node.module:
                    continue
                parts = node.module.split(".")
                if parts[:2] == ["iclip", "domains"] and len(parts) >= 3:
                    target = parts[2]
                    if (
                        target in domains
                        and target != own
                        and (len(parts) < 4 or parts[3] != "public")
                    ):
                        violations.append(f"{rel}: 绕过 public 引 {node.module}")
    assert not violations, "\n".join(violations)


def test_models_and_commands_are_pure() -> None:

    import sys

    stdlib = set(sys.stdlib_module_names)
    violations: list[str] = []
    for name in ("models.py", "commands.py"):
        for path in (SRC / "domains").rglob(name):
            for top in _imported_top_levels(path):
                if top not in stdlib and top != "iclip":
                    violations.append(f"{_rel(path)}: 第三方 {top}")
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if (
                    isinstance(node, ast.ImportFrom)
                    and node.module
                    and node.module.startswith("iclip.")
                    and not node.module.startswith("iclip.common")
                    and not node.module.startswith(f"iclip.domains.{path.parent.name}")
                ):
                    violations.append(f"{_rel(path)}: {node.module}")
    assert not violations, "\n".join(violations)


def test_no_silent_exception_fallbacks() -> None:

    violations: list[str] = []
    for path in _python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ExceptHandler):
                continue
            if node.type is None:
                violations.append(f"{_rel(path)}:{node.lineno} 裸 except")
            elif len(node.body) == 1 and isinstance(node.body[0], ast.Pass):
                violations.append(f"{_rel(path)}:{node.lineno} except: pass")
    assert not violations, "\n".join(violations)


def test_config_only_consumed_by_app() -> None:

    violations: list[str] = []
    for path in (SRC / "domains").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.ImportFrom)
                and node.module
                and node.module.startswith("iclip.config")
            ):
                violations.append(_rel(path))
    assert not violations, "\n".join(violations)
