"""agents 域对外暴露的类型。"""

from __future__ import annotations

from dataclasses import dataclass

from iclip.domains.identity.public import Principal


@dataclass(frozen=True, slots=True)
class AgentRunDeps:
    """运行主体与对话上下文，通过 ctx.deps 继承至下属运行。

    下属运行的 ctx.conversation_id 可能重新生成，工作区隔离必须使用这里继承的对话 id。
    principal 是可信身份；conversation_id 仅作属主之下的隔离维度，不能单独决定访问范围。
    user_name 是这次运行替谁跑的归属标签，工具把它发给上游落表；它不是身份，不参与授权。"""

    principal: Principal
    conversation_id: str
    user_name: str


__all__ = ["AgentRunDeps"]
