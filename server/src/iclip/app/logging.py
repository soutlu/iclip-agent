"""进程里所有日志走 structlog 一条线。

标准库来源（uvicorn 以 ``log_config=None`` 启动、procrastinate、httpx）与我们自己的 structlog
logger 都落到 root 的一个 handler，由 ProcessorFormatter 用同一条处理链渲染：开发是对齐的
控制台行，生产按 ``ops.log_format: json`` 一行一个 JSON。中间件绑上的请求上下文（request_id、
principal）随 contextvars 合进每一行，uvicorn 的访问日志也带。
"""

from __future__ import annotations

import logging
import sys
from typing import Literal

import structlog
from structlog.typing import Processor

LogFormat = Literal["console", "json"]

QUIET_LOGGERS = ("procrastinate", "httpx")
"""常态下只看告警的第三方 logger：周期心跳、每次外呼各打一行 INFO，没有信息量。"""


def configure_logging(level: str, fmt: LogFormat) -> None:
    """配 root 的 handler、格式与级别。重复调用整体替换，不叠 handler。"""

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
        # 不缓存：监督进程与 worker、测试之间会反复配置，缓存会让先用过的 logger 留在旧配置上
        cache_logger_on_first_use=False,
    )


__all__ = ["QUIET_LOGGERS", "LogFormat", "configure_logging"]
