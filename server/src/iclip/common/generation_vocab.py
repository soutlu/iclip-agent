"""生成记录的种类、操作与业务状态词表；属主是生成域，推送帧也引这一份。"""

from __future__ import annotations

from typing import Literal

GenerationKind = Literal["video", "image"]
"""产出的是什么媒体；谁执行看 provider，不另立种类。"""

GenerationOperation = Literal["generate", "compose"]
"""一行记录怎么执行：调模型（generate）或本地拼接（compose）。"""

GenerationStatus = Literal["pending", "submitting", "submitted", "completed", "failed"]
"""生成记录的业务状态，各词含义见 ``iclip.domains.generation.schemas`` 的 ``STATUS_*``。"""

__all__ = ["GenerationKind", "GenerationOperation", "GenerationStatus"]
