"""需求单产品快照协议，具体实现由组合根注入。"""

from __future__ import annotations

from typing import Protocol

from iclip.domains.tasks.schemas import TaskStyle


class StyleSnapshots(Protocol):
    """按款号取一份可以冻结进需求单的快照。"""

    async def of(self, style_no: str) -> TaskStyle:
        """读取款号对应的品牌、品类与封面快照。

        款号不存在抛 ValidationFailed；封面转存失败向上传播，创建整体失败。"""
        ...


__all__ = ["StyleSnapshots"]
