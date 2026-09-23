"""生成记录的种类与业务状态词表；属主是生成域，推送帧也引这一份。"""

from __future__ import annotations

from typing import Literal

GenerationKind = Literal["video", "image", "clip"]

GenerationStatus = Literal["pending", "submitting", "submitted", "completed", "failed"]
"""生成记录的业务状态，各词含义见 ``iclip.domains.generation.schemas`` 的 ``STATUS_*``。"""

__all__ = ["GenerationKind", "GenerationStatus"]
