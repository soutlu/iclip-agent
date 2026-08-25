"""对话的领域模型。

一段对话就是用户在界面上看到的一个聊天窗口：它有名字、有主人，里面来回跑过很多次
运行。运行本身的记录不在这里（那是 agent 引擎的账本），这张表只回答「有哪些对话、
归谁、叫什么、最近一次运行是哪个」。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class Conversation:
    """一段对话的持久事实行。"""

    id: uuid.UUID
    owner_user_id: uuid.UUID
    agent_id: str
    """这段对话跑哪个 agent。agent 在配置文件里声明，库里没有对应的行，所以没有外键。"""
    title: str
    last_run_id: str | None
    """客户端为最近一次运行铸造的 id。刷新页面后靠它接回还没跑完的那次；没发过消息时为空。"""
    created_at: datetime
    updated_at: datetime


__all__ = ["Conversation"]
