"""agents 域对外暴露的类型。"""

from __future__ import annotations

from dataclasses import dataclass

from iclip.domains.identity.public import Principal


@dataclass(frozen=True, slots=True)
class AgentRunDeps:
    """一次 agent 运行的依赖：谁在跑，以及跑在哪段对话里。

    工具执行时经 ``ctx.deps`` 拿到它。派活时官方会把 deps 原样转发给下属，所以
    主 agent 和它的下属看到的是同一个对象——**运行自己的 ``conversation_id`` 不
    转发**（实测：下属那次运行会拿到一个新生成的 id），所以「这段对话」这件事
    必须搭 deps 的车走，不能让能力去读 ``ctx.conversation_id``。

    两个字段的可信程度不一样，别混着用：``principal`` 是从凭证解析出来的，可
    信；``conversation_id`` 是客户端在请求体里给的（AG-UI 的 ``threadId``），所
    以它只能当**次级**隔离段，永远不能单独当隔离根——否则换一个 id 就能读到别
    人的东西。
    """

    principal: Principal
    conversation_id: str


__all__ = ["AgentRunDeps"]
