"""prompt 队列里一条消息的状态；jobs 落库与 transcript 投影共用，本模块不依赖二者。"""

from typing import Literal

JobStatus = Literal["running", "awaiting", "queued", "steered", "completed", "failed", "aborted"]

__all__ = ["JobStatus"]
