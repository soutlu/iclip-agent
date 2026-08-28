"""核对仓内 Markdown：相对链接指向的文件必须存在，提到的 make 目标必须在 Makefile 里。

只用标准库；`make docs-check` 调用，失败时逐条列出并以非零退出。
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
MAKE_MENTION = re.compile(r"`make ([A-Za-z0-9_-]+)`")
MAKE_TARGET = re.compile(r"^([A-Za-z0-9_-]+):", re.M)


def tracked_markdown() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "*.md", "**/*.md"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout
    return [ROOT / line for line in out.splitlines() if "node_modules" not in line]


def main() -> int:
    targets = set(MAKE_TARGET.findall((ROOT / "Makefile").read_text(encoding="utf-8")))
    problems: list[str] = []
    for md in tracked_markdown():
        text = md.read_text(encoding="utf-8")
        rel = md.relative_to(ROOT)
        for raw in LINK.findall(text):
            if raw.startswith(("http://", "https://", "mailto:", "#")):
                continue
            path = raw.split("#", 1)[0]
            if path and not (md.parent / path).exists():
                problems.append(f"{rel}: 链接不存在 {raw}")
        for target in MAKE_MENTION.findall(text):
            if target not in targets:
                problems.append(f"{rel}: Makefile 没有 `make {target}`")
    for line in problems:
        print(line)
    if problems:
        print(f"[docs] {len(problems)} 处不符")
        return 1
    print("[docs] 链接与 make 目标核对通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
