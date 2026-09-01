"""一段对话此刻「在忙什么」的聚合。侧栏的角标看的是这一份。

形状照 kimi 的 ``SessionActivityView``（``agent-core-v2/src/session/sessionActivity/``），三条规矩
一并照抄：

1. **正交事实，不合成一个枚举。** kimi 原来有一个五值 ``status``，后来废弃了，理由写在它的
   ``@deprecated`` 注释里：等审批的时候那一轮**其实还在跑**，塞进同一个枚举就分不清「在跑」和
   「等人点头」。所以这里是两个各自独立的字段，怎么画由界面自己决定。
2. **待人处理的优先级写死** ``approval > question > none``。
3. **算出来一样就不发**（``ActivityState`` 是 frozen dataclass，直接比相等）。推送这条路上，
   「值没变也发一帧」意味着每来一批操作就惊动一次侧栏。

kimi 还有 ``main_turn_active``（排除后台与子 agent 的主轮活跃）与 ``last_turn_reason``（最近一轮的
结局）。这里没有：我们既没有后台租约也没有子 agent，而失败角标的界面还没做——真要画的时候再加
字段，不先摆着。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

PendingInteraction = Literal["none", "approval", "question"]
"""最高优先级的那件待人处理的事。"""


@dataclass(frozen=True, slots=True)
class ActivityState:
    """一段对话此刻的活儿。两个字段互不蕴含，见模块开头第 1 条。"""

    busy: bool
    """有轮次正在跑。"""

    pending_interaction: PendingInteraction = "none"
    """有没有卡在等人点头。**等审批时 ``busy`` 照样为真**——那一轮并没有结束。"""


IDLE = ActivityState(busy=False)
"""什么都没在发生。内存里没有这段对话时也是这一份。"""


@dataclass(frozen=True, slots=True)
class AgentWork:
    """一个 agent 此刻的活儿，由持有实时状态的那一侧摘出来。照 kimi 的 ``AgentWorkFold``。"""

    turn_active: bool
    pending_kinds: tuple[Literal["approval", "question"], ...] = ()


def aggregate(work: Mapping[str, AgentWork]) -> ActivityState:
    """把各 agent 的活儿聚成一段对话的活儿。

    :param work: agent id → 它此刻的活儿。
    :returns: 这段对话此刻的活儿。
    """

    busy = any(one.turn_active for one in work.values())
    kinds = {kind for one in work.values() for kind in one.pending_kinds}
    # 优先级写死：审批比提问要紧，都没有就是 none。
    pending: PendingInteraction = (
        "approval" if "approval" in kinds else "question" if "question" in kinds else "none"
    )
    return ActivityState(busy=busy, pending_interaction=pending)


__all__ = ["IDLE", "ActivityState", "AgentWork", "PendingInteraction", "aggregate"]
