"""统一标准库与 structlog 日志。单个 root handler 通过 ProcessorFormatter 输出 console 或 JSON。
请求上下文经 contextvars 合并至日志，包括 uvicorn 访问日志。"""

from __future__ import annotations

import logging
import sys
from typing import Literal

import structlog
from structlog.typing import Processor

LogFormat = Literal["console", "json"]

QUIET_LOGGERS = ("procrastinate", "httpx")
"""仅保留警告及以上级别的第三方 logger，抑制周期心跳与逐请求 INFO。"""


def configure_logging(level: str, fmt: LogFormat) -> None:
    """整体替换 root 日志配置，重复调用不叠加 handler。"""

    shared: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso" if fmt == "json" else "%H:%M:%S"),
    ]
    tail: list[Processor] = (
        [
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(ensure_ascii=False),
        ]
        if fmt == "json"
        else [structlog.dev.ConsoleRenderer(colors=sys.stderr.isatty())]
    )
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=shared,
            processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, *tail],
        )
    )
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        # 禁用缓存，使重新配置可应用于已使用的 logger。
        cache_logger_on_first_use=False,
    )


__all__ = ["QUIET_LOGGERS", "LogFormat", "configure_logging"]
