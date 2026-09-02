"""一段对话此刻「在忙什么」。侧栏的角标看的是这一份。

**这份状态是 ``agent_runtime.agent_jobs`` 里某一行状态的投影**：占着这段对话的那条行给出
``busy`` 与待人处理的那件事，最近结束的那条行给出上一轮的结局。哪一行算「决定活儿的那一行」由
``JobQueue.activities`` 定，本模块只做状态到状态的映射，不查库。

形状照 kimi 的 ``SessionActivityView``（``agent-core-v2/src/session/sessionActivity/``），两条规矩
一并照抄：

1. **正交事实，不合成一个枚举。** kimi 原来有一个五值 ``status``，后来废弃了，理由写在它的
   ``@deprecated`` 注释里：等审批的时候那一轮**其实还在跑**，塞进同一个枚举就分不清「在跑」和
   「等人点头」。所以这里是各自独立的字段，怎么画由界面自己决定。
2. **待人处理的优先级写死** ``approval > question > none``。

kimi 还有 ``main_turn_active``（排除后台与子 agent 的主轮活跃）。这里没有：我们既没有后台租约
也没有子 agent。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    # 只用来标注入参。运行时反过来是 jobs 认识本模块，两边都 import 就成了环。
    from iclip.harness.jobs import JobStatus

PendingInteraction = Literal["none", "approval", "question"]
"""最高优先级的那件待人处理的事。"""

LastTurnReason = Literal["completed", "failed", "aborted"]
"""最近一轮是怎么结束的。"""


@dataclass(frozen=True, slots=True)
class ActivityState:
    """一段对话此刻的活儿。三个字段互不蕴含，见模块开头第 1 条。"""

    busy: bool
    """有轮次正在跑。"""

    pending_interaction: PendingInteraction = "none"
    """有没有卡在等人点头。**等审批时 ``busy`` 照样为真**——那一轮并没有结束。"""

    last_turn_reason: LastTurnReason | None = None
    """最近结束的那一轮的结局。从没跑完过一轮的对话是 ``None``。"""


IDLE = ActivityState(busy=False)
"""什么都没在发生，也没有跑过。库里查不到决定活儿的那一行时就是这一份。"""


def activity_of(status: JobStatus | None) -> ActivityState:
    """决定活儿的那条行的状态 → 这段对话的活儿。

    :param status: 那一行的状态；库里没有这样的行就给 ``None``。
    :returns: 这段对话此刻的活儿。
    """

    match status:
        case "running" | "steered":
            return ActivityState(busy=True)
        case "awaiting":
            return ActivityState(busy=True, pending_interaction="approval")
        case "completed" | "failed" | "aborted":
            return ActivityState(busy=False, last_turn_reason=status)
        case _:
            # ``queued`` 也走这里：排着的行从来不是决定活儿的那一行。
            return IDLE


__all__ = [
    "IDLE",
    "ActivityState",
    "LastTurnReason",
    "PendingInteraction",
    "activity_of",
]
