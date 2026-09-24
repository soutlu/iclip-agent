"""工作区命名空间规则：可信属主为外层，对话 id 为内层。

主 Agent 与下属通过 AgentRunDeps 继承同一对话，不能使用下属新生成的 ctx.conversation_id。
命名空间统一由本模块构造与反解，供读写与删除共用。"""

from __future__ import annotations

import uuid
from typing import Any

from pydantic_ai.tools import RunContext

from iclip.domains.agents.public import AgentRunDeps
from iclip.platform.file_store.store import normalize_path


def namespace_for(owner: uuid.UUID, conversation_id: str) -> str:
    """由属主与对话 id 构造统一命名空间，按工作区路径规则归一化，与 ``FileSpace.resolve`` 一致。

    对话 id 形状非法时抛 ``InvalidPath``。"""

    return normalize_path(f"{owner}/{conversation_id}")


def parse_namespace(namespace: str) -> tuple[uuid.UUID, uuid.UUID]:
    """``namespace_for`` 的反解，返回属主与对话 id；不是对话命名空间时抛 ``ValueError``。"""

    owner, _, conversation_id = namespace.partition("/")
    try:
        return uuid.UUID(owner), uuid.UUID(conversation_id)
    except ValueError as exc:
        raise ValueError(f"{namespace!r} 不是「属主/对话 id」形式的工作区命名空间") from exc


def workspace_namespace(ctx: RunContext[Any]) -> str:
    """从可信运行依赖解析命名空间；依赖缺失或类型错误时直接失败，禁止退回公共空间。"""

    deps = ctx.deps
    if not isinstance(deps, AgentRunDeps):
        raise RuntimeError(
            f"工作区算不出命名空间：这次运行的 deps 是 {type(deps).__name__}，"
            "不是 AgentRunDeps——运行身份没有注入进来。"
        )
    return namespace_for(deps.principal.user_id, deps.conversation_id)


__all__ = ["namespace_for", "parse_namespace", "workspace_namespace"]
