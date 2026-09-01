"""对话的领域模型。

一段对话就是用户在界面上看到的一个聊天窗口：它有名字、有主人，里面来回跑过很多次
运行。运行本身的记录不在这里（那是 agent 引擎的账本），这张表只回答「有哪些对话、
归谁、叫什么、最近一次运行是哪个、为哪张单开的、放在哪个合集里」。

一张需求单下面可以有好几段对话——每段就是一次尝试，第几次按 ``created_at`` 排。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

TitleKind = Literal["default", "generated", "custom"]
"""标题的来路。库上有同名的检查约束，两处要一起改。"""


@dataclass(frozen=True, slots=True)
class Conversation:
    """一段对话的持久事实行。"""

    id: uuid.UUID
    owner_user_id: uuid.UUID
    agent_id: str
    """这段对话跑哪个 agent。agent 在配置文件里声明，库里没有对应的行，所以没有外键。"""
    title: str
    title_kind: TitleKind
    """标题是谁起的：还没起过、小模型起的、用户自己起的。

    自动生成只在 ``default`` 这一档发生，且只发生一次：起过就不再动，用户自己改过的更不动。
    """
    last_run_id: str | None
    """客户端为最近一次运行铸造的 id。刷新页面后靠它接回还没跑完的那次；没发过消息时为空。"""
    task_id: uuid.UUID | None
    """这段对话是为哪张需求单开的。空着就是直接开始创作，不属于任何一张单。

    随时可以改：跑完才发现该记在哪张单下，是常事。
    """
    collection_id: uuid.UUID | None
    """放在哪个合集里，最多一个。空着就是没归类，随时可以换一个或者拿出来。"""
    created_at: datetime
    updated_at: datetime


__all__ = ["Conversation", "TitleKind"]
