"""需求单要向外借的那一件事：按款号抄一份产品资料快照。

只写协议，真身由组合根接上去——需求单域不认识产品资料库也不认识对象存储（同能力包
``ports.py`` 的写法）。
"""

from __future__ import annotations

from typing import Protocol

from iclip.domains.tasks.schemas import TaskStyle


class StyleSnapshots(Protocol):
    """按款号取一份可以冻结进需求单的快照。"""

    async def of(self, style_no: str) -> TaskStyle:
        """查这个款，抄下它此刻的品牌、品类与封面。

        查不到抛 ``ValidationFailed``（参数的语义错，不是「需求单不存在」）；抄封面
        失败一律往外抛，这次创建整体失败。
        """
        ...


__all__ = ["StyleSnapshots"]
