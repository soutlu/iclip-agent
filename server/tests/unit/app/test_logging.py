"""验证标准库与 structlog 统一日志格式及请求上下文。"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator

import pytest
import structlog

from iclip.app.logging import QUIET_LOGGERS, configure_logging


@pytest.fixture
def restore_logging() -> Iterator[None]:
    """恢复 root handler，避免 configure_logging 影响 pytest 日志捕获。"""

    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    quiet = {name: logging.getLogger(name).level for name in QUIET_LOGGERS}
    try:
        yield
    finally:
        root.handlers[:] = handlers
        root.setLevel(level)
        for name, saved in quiet.items():
            logging.getLogger(name).setLevel(saved)
        structlog.reset_defaults()
        structlog.contextvars.clear_contextvars()


def test_json_lines_share_one_shape_and_carry_context(
    capsys: pytest.CaptureFixture[str], restore_logging: None
) -> None:
    configure_logging("INFO", "json")
    structlog.contextvars.bind_contextvars(request_id="req-1")

    logging.getLogger("uvicorn.access").info('%s - "%s" %d', "127.0.0.1", "GET /x", 200)
    structlog.stdlib.get_logger("iclip.test").warning("捡回中断的生成任务", count=2)
    logging.getLogger("procrastinate.worker").info("Starting job")

    lines = [json.loads(line) for line in capsys.readouterr().err.splitlines()]
    assert [line["logger"] for line in lines] == ["uvicorn.access", "iclip.test"]
    access, ours = lines
    assert access["event"] == '127.0.0.1 - "GET /x" 200'
    assert access["level"] == "info"
    assert access["request_id"] == "req-1"
    assert ours["event"] == "捡回中断的生成任务"
    assert ours["count"] == 2
    assert ours["request_id"] == "req-1"
    assert "timestamp" in ours


def test_console_line_keeps_event_and_fields(
    capsys: pytest.CaptureFixture[str], restore_logging: None
) -> None:
    configure_logging("INFO", "console")

    structlog.stdlib.get_logger("iclip.test").info("生成任务提交失败", job_id="j1", code="E1")

    (line,) = capsys.readouterr().err.splitlines()
    assert "生成任务提交失败" in line
    assert "job_id=j1" in line
    assert "code=E1" in line
    assert "iclip.test" in line
