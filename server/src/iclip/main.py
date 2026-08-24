"""CLI serve 入口。装配发生在每个 worker import ``iclip.asgi`` 时。"""

from __future__ import annotations

import argparse
import os

import uvicorn


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
    uvicorn.run(
        "iclip.asgi:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        workers=args.workers if not args.reload else 1,
    )


if __name__ == "__main__":
    main()
