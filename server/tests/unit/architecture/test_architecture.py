"""架构契约：框架围栏、模块纯度、无静默兜底。

tach 守模块依赖图；本文件守 tach 表达不了的红线。
"""

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[3] / "src" / "iclip"

# 框架 → 允许直接 import 的文件（相对 src/iclip 的 glob 语义前缀）。
#
# 这张表是登记表，不是配额：新增一个碰外部存储或框架的文件不是违规，但必须在
# 这里登记一行，并同步 docs/architecture.md 的落点表；没登记的 import 直接拒。
FRAMEWORK_FENCES: dict[tuple[str, ...], tuple[str, ...]] = {
    ("pydantic_ai",): ("harness/", "capabilities/"),
    ("pydantic_ai_harness",): ("harness/",),
    # AG-UI 的协议类型只准在 harness 里用。HTTP 面拿到的是已经编码好的字符串，
    # 让它直接碰协议对象的话，以后换协议就得连业务代码一起改。
    ("ag_ui",): ("harness/",),
    ("fastapi", "starlette"): (
        "app/",
        "domains/identity/api.py",
        "domains/agents/api.py",
        "domains/conversations/api.py",
        "domains/generation/api.py",
        "domains/products/api.py",
        "domains/inspirations/api.py",
        "domains/tasks/api.py",
        "domains/uploads/api.py",
        "domains/identity/middleware.py",
        "domains/identity/accounts.py",
        "main.py",
    ),
    ("sqlalchemy",): (
        "platform/db/",
        # 命名空间化文本文件存储的 PG 后端；和 object_store/oss.py 同一类东西。
        "platform/file_store/",
        "app/",
        # 协议后端跟着「说这门协议的那一环」走：这是官方 StepPersistence 的 PG
        # 后端，而 harness/agents.py 正是按 StepStore 协议标类型的那一方。
        "harness/step_store_pg.py",
        # 外部只读源：这些表是别人的（PDM 的同步副本），不是本模块自有的表，所以
        # 不叫 infra_sql.py——那个名字在落点表里的口径是「该模块自有的表」。
        "domains/products/catalog_pg.py",
        "domains/inspirations/catalog_pg.py",
    ),
    ("fastapi_users", "fastapi_users_db_sqlalchemy"): ("domains/identity/",),
    # 模型装配唯一需要直接碰 openai SDK 的地方（给兼容端点造客户端）。
    ("openai",): ("harness/models.py",),
    # 阿里云 OSS SDK 只在对象存储适配器里；业务侧只认 PublicObjectStore 协议。
    ("oss2",): ("platform/object_store/",),
    # 预览板拼版；只有这一处需要位图库。
    ("PIL",): ("capabilities/shot_video/board.py",),
    # 生成任务的排队机械。queue.py 是唯一说这门话的地方；module.py 只为了在签名里
    # 写出连接器的类型；组合根造那个连接器（它决定本仓用哪个数据库驱动）。
    ("procrastinate",): (
        "domains/generation/queue.py",
        "domains/generation/module.py",
        "app/",
    ),
}
# 模块自有的 SQL 放自己模块里的 infra_sql.py——下面这些前缀底下按文件名放行。
# 与上面那条协议后端规则并列：谁拥有这张表，SQL 就落在谁的模块里。
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
    """跨业务模块只准 import 对方 public;capabilities 引 domains 同样只准走 public。"""

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
    """models.py / commands.py 只许 stdlib、iclip.common 与本模块。"""

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
    """禁止裸 except 与 except 后只 pass 的静默兜底。"""

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
    """domains 不 import config：业务模块只接收构造好的运行设置。"""

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
