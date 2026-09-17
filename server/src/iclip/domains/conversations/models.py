"""对话持久模型，记录身份、标题、归属与最近运行标识。运行历史由 agent 引擎持久化。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

TitleKind = Literal["default", "generated", "custom"]
"""标题来源，取值须与数据库检查约束同步。"""


@dataclass(frozen=True, slots=True)
class Conversation:
    """一段对话的持久事实行。已删除的行只经治理者的读路径进入领域层，属主与所有写路径都当它不存在。"""

    id: uuid.UUID
    owner_user_id: uuid.UUID
    agent_id: str
    """Agent 由配置声明，无对应数据库外键。"""
    title: str
    title_kind: TitleKind
    """仅 default 标题可自动生成；已生成或用户自定义的标题不再自动覆盖。"""
    last_run_id: str | None
    """最近一次运行的 id，用于重连未结束的运行；未发过消息时为空。"""
    task_id: uuid.UUID | None
    """可修改的需求单归属；为空时不关联需求单。"""
    collection_id: uuid.UUID | None
    """可修改的合集归属；为空时未分类。"""
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None
    """属主删除它的时刻；活着的对话为空。"""
    forked_from: uuid.UUID | None = None
    """分叉来源对话；不是分叉来的为空。与 ``fork_turn`` 同时有值。"""
    fork_turn: int | None = None
    """分叉自源对话的第几轮，从 1 数。与 ``forked_from`` 同时有值。"""


@dataclass(frozen=True, slots=True)
class ConversationActivity:
    """对话活动投影。各字段独立，等待审批或回答时 busy 仍为真。"""

    busy: bool = False
    pending_interaction: Literal["none", "approval", "question"] = "none"
    last_turn_reason: Literal["completed", "failed", "aborted"] | None = None
    """最近结束轮次的结果；从未完成轮次时为 None。"""
    video_generation: Literal["none", "queued", "running"] = "none"
    """这段对话下还没跑完的视频出片到哪一步；跑完与失败在分镜页看，这里不记。"""


IDLE_ACTIVITY = ConversationActivity()
"""无运行记录或活动信息时使用的空闲状态。"""


__all__ = ["IDLE_ACTIVITY", "Conversation", "ConversationActivity", "TitleKind"]
