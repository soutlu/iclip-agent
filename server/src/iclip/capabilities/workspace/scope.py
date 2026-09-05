"""工作区命名空间规则：可信属主为外层，对话 id 为内层。

主 Agent 与下属通过 AgentRunDeps 继承同一对话，不能使用下属新生成的 ctx.conversation_id。
命名空间统一由本模块构造，供读写与删除共用。"""

from __future__ import annotations

import uuid
from typing import Any

from pydantic_ai.tools import RunContext

from iclip.domains.agents.public import AgentRunDeps


def namespace_for(owner: uuid.UUID, conversation_id: str) -> str:
    """由属主与对话 id 构造统一命名空间。"""

    return f"{owner}/{conversation_id}"


def workspace_namespace(ctx: RunContext[Any]) -> str:
    """从可信运行依赖解析命名空间；依赖缺失或类型错误时直接失败，禁止退回公共空间。"""

    deps = ctx.deps
    if not isinstance(deps, AgentRunDeps):
        raise RuntimeError(
            f"工作区算不出命名空间：这次运行的 deps 是 {type(deps).__name__}，"
            "不是 AgentRunDeps——运行身份没有注入进来。"
        )
    return namespace_for(deps.principal.user_id, deps.conversation_id)


__all__ = ["namespace_for", "workspace_namespace"]
