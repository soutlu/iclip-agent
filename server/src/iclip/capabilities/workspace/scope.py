"""工作区归谁：这个系统里的答案。

能力本体（``capability.py``）不认识身份在这个系统里是怎么表示的，它只要一个
``ctx -> str`` 的函数。这个文件就是那个函数——把「工作区按什么分」这个产品决定
收在一处，改粒度只改这里。

**一段对话一个工作区，主 agent 和它的下属共用。** 派活是另起一次运行，而官方会
把 deps 原样转发给下属——所以「这段对话」这件事搭 deps 的车走就自然共用了。不能
去读运行自己的 ``ctx.conversation_id``：那个**不**转发，下属那次运行拿到的是一个
新生成的 id，于是下属写的稿子主 agent 就看不见了，派活等于白干。

**用户 id 在外层，对话 id 在内层。** 对话 id 是客户端在请求体里给的（AG-UI 的
``threadId``），单靠它当隔离根的话，换一个 id 就能读到别人的文件。套在可信的用户
id 底下，伪造 id 最多只能碰到自己的另一段对话。
"""

from __future__ import annotations

import uuid
from typing import Any

from pydantic_ai.tools import RunContext

from iclip.domains.agents.public import AgentRunDeps


def namespace_for(owner: uuid.UUID, conversation_id: str) -> str:
    """按「谁的 + 哪段对话」拼出命名空间。

    这个拼法只写在这里一处。删对话时要连带清空对应的地盘，那件事发生在别的模块，
    要是它自己再拼一遍，两处哪天不一致就会静默删错地方（或者一个也删不掉）。
    """

    return f"{owner}/{conversation_id}"


def workspace_namespace(ctx: RunContext[Any]) -> str:
    """算出这次运行的工作区命名空间。

    算不出来就抛，绝不退回某个公共命名空间——那等于把所有人的工作区并成一个。
    ``deps`` 不是 ``AgentRunDeps`` 说明装配出错了（运行身份没注进来），是 bug
    不是用户输入，所以让它炸而不是翻译成一句模型能重试的话。
    """

    deps = ctx.deps
    if not isinstance(deps, AgentRunDeps):
        raise RuntimeError(
            f"工作区算不出命名空间：这次运行的 deps 是 {type(deps).__name__}，"
            "不是 AgentRunDeps——运行身份没有注入进来。"
        )
    return namespace_for(deps.principal.user_id, deps.conversation_id)


__all__ = ["namespace_for", "workspace_namespace"]
