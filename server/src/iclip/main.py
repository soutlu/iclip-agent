"""CLI serve 入口。装配发生在每个 worker import ``iclip.asgi`` 时。"""

from __future__ import annotations

import argparse
import os

import uvicorn

from iclip.app.logging import configure_logging


def main() -> None:
    parser = argparse.ArgumentParser(description="iClip Agent server")
    parser.add_argument("--config", default="configs/config.yaml")
    parser.add_argument("--agents", default="agents/agents.yaml")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=7788)
    parser.add_argument("--reload", action="store_true")
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()

    if args.workers < 1:
        parser.error("--workers 必须 ≥ 1")
    if args.reload and args.workers > 1:
        parser.error("--reload 与多 worker 互斥")

    os.environ["CONFIG_FILE"] = args.config
    os.environ["AGENTS_FILE"] = args.agents
    # 这里先配一遍给监督进程（reload / 多 worker 时 uvicorn 的启动行由它打）；
    # 每个 worker 进程装配 app 时再按 config.yaml 的级别与格式配自己那一份。
    configure_logging("INFO", "console")
    uvicorn.run(
        "iclip.asgi:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        workers=args.workers if not args.reload else 1,
        # 不让 uvicorn 自带一套 handler，它的日志与其他来源同一格式
        log_config=None,
    )


if __name__ == "__main__":
    main()
