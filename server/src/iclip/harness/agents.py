"""Agent 装配与官方协议事件流：全仓唯一 import ``pydantic_ai_harness`` 的装配点。

装配在启动期一次性完成并冻结（``defer_model_check`` 留默认值，模型/凭证缺失
即在此刻失败，而不是等到第一个请求）。运行期只按 id 取用。

对外只暴露两件事：注册表里有哪些 id，以及「给一段请求体、还一串协议帧」。
这个接缝刻意不碰任何 HTTP 类型——它同样能被后台任务和测试直接驱动。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError
from pydantic_ai import Agent
from pydantic_ai.capabilities import AgentCapability
from pydantic_ai.ui.vercel_ai import VercelAIAdapter
from pydantic_ai_harness.subagents import SubAgent, SubAgents

from iclip.common.errors import NotFound, ValidationFailed


@dataclass(frozen=True, slots=True)
class SubAgentDefinition:
    """一条派活关系：下属的身份、spec，加这次派活的资源额度。"""

    name: str
    spec: Path
    instructions: Path | None = None
    timeout_seconds: float | None = None
    max_calls: int | None = None
    on_failure: str | None = None


@dataclass(frozen=True, slots=True)
class AgentDefinition:
    """一个待注册 agent 的装配输入。``agent_id`` 会被强制成为它的 ``name``。"""

    agent_id: str
    spec: Path
    instructions: Path | None = None
    subagents: tuple[SubAgentDefinition, ...] = ()


def _read_instructions(path: Path | None) -> str | None:
    """读提示词正文；空文件按「没有提示词」处理，不注入空指令。"""

    if path is None:
        return None
    return path.read_text(encoding="utf-8").strip() or None


def _load_agent(
    spec: Path,
    instructions: Path | None,
    *,
    name: str | None = None,
    capabilities: Sequence[AgentCapability[Any]] | None = None,
) -> Agent[Any, Any]:
    return Agent.from_file(
        spec,
        name=name,
        instructions=_read_instructions(instructions),
        capabilities=capabilities,
    )


def _build_subagents(definitions: Sequence[SubAgentDefinition]) -> SubAgents[Any]:
    return SubAgents(
        agents=[
            SubAgent(
                _load_agent(sub.spec, sub.instructions, name=sub.name),
                timeout_seconds=sub.timeout_seconds,
                max_calls=sub.max_calls,
                on_failure=sub.on_failure,
            )
            for sub in definitions
        ],
        # 必须显式关掉磁盘扫描。默认值 'agents' 会扫 <cwd>/.agents|.claude/agents/
        # 以及 ~ 下的同名目录——开发者个人的 agent 定义会静默变成生产下属，
        # 同一份代码在不同机器上行为不同且不报错。子 agent 一律走显式声明。
        agent_folders=None,
    )


@dataclass(frozen=True, slots=True)
class AgentRegistry:
    """启动期冻结的 id → Agent 映射。"""

    agents: Mapping[str, Agent[Any, Any]]

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(self.agents)

    def stream(self, agent_id: str, body: bytes, accept: str | None) -> AsyncIterator[str]:
        """跑一次运行，返回官方 Vercel AI 协议的编码帧流。

        未注册的 id 抛 ``NotFound``、请求体形状不合法抛 ``ValidationFailed``，
        两者都在返回迭代器之前发生，因此调用方能拿到正常的错误响应。
        """

        agent = self.agents.get(agent_id)
        if agent is None:
            raise NotFound(f"未注册的 agent: {agent_id}")
        try:
            run_input = VercelAIAdapter.build_run_input(body)
        except ValidationError as exc:
            raise ValidationFailed("请求体不符合 Vercel AI 协议") from exc
        adapter = VercelAIAdapter[Any, Any](agent=agent, run_input=run_input, accept=accept)
        return adapter.encode_stream(adapter.run_stream())


def build_agent_registry(definitions: Sequence[AgentDefinition]) -> AgentRegistry:
    """按声明装配全部 agent；id 重复由调用方的声明结构保证不会发生。"""

    agents: dict[str, Agent[Any, Any]] = {}
    for definition in definitions:
        capabilities = [_build_subagents(definition.subagents)] if definition.subagents else None
        agents[definition.agent_id] = _load_agent(
            definition.spec,
            definition.instructions,
            name=definition.agent_id,
            capabilities=capabilities,
        )
    return AgentRegistry(agents=agents)


__all__ = [
    "AgentDefinition",
    "AgentRegistry",
    "SubAgentDefinition",
    "build_agent_registry",
]
