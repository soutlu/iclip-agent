"""transcript 形状自己带的那几条硬约束。"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from iclip.platform.transcript.ops import TextFrame


def test_a_user_block_must_carry_its_parts() -> None:
    """用户块少了 part 列表就该造不出来：界面按它画图文，只有 ``text`` 的话图就没了。"""

    with pytest.raises(ValidationError):
        TextFrame(frame_id="t1.1.f1", role="user", text="照这张做")
