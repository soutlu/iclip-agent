"""验证 transcript 模型约束。"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from iclip.platform.transcript.ops import TextFrame


def test_a_user_block_must_carry_its_parts() -> None:
    """用户块必须保留 parts，纯 text 字段无法表达图片内容。"""

    with pytest.raises(ValidationError):
        TextFrame(frame_id="t1.1.f1", role="user", text="照这张做")
