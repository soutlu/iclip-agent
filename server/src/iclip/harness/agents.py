"""Agent 装配与官方协议事件流：全仓唯一 import ``pydantic_ai_harness`` 的装配点。

装配在启动期完成并冻结，运行期只按 id 取用。每个 agent（含子代理）挂官方
``StepPersistence`` 落 ``step_store``，模型从传入的 ``models`` 表按名字取
（spec 里的 ``model:`` 被覆盖）。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError
from pydantic_ai import Agent, AgentSpec
from pydantic_ai.capabilities import AgentCapability
from pydantic_ai.models import Model
from pydantic_ai.ui.ag_ui import AGUIAdapter
from pydantic_ai_harness.step_persistence import StepPersistence, StepStore
from pydantic_ai_harness.subagents import SubAgent, SubAgents

from iclip.common.errors import NotFound, ValidationFailed
from iclip.harness.models import BuiltModels


@dataclass(frozen=True, slots=True)
class SubAgentDefinition:
    """一条派活关系：下属的身份、spec，加这次派活的资源额度。"""

    name: str
    spec: Path
    model: str
    instructions: Path | None = None
    timeout_seconds: float | None = None
    max_calls: int | None = None
    on_failure: str | None = None


@dataclass(frozen=True, slots=True)
class AgentDefinition:
    """一个待注册 agent 的装配输入。``agent_id`` 会被强制成为它的 ``name``。"""

    agent_id: str
    spec: Path
    model: str
    instructions: Path | None = None
    subagents: tuple[SubAgentDefinition, ...] = ()


def _read_spec(path: Path) -> AgentSpec:
    """读 spec；空文件视为没有额外声明。"""

    return AgentSpec.from_dict(yaml.safe_load(path.read_text(encoding="utf-8")) or {})


def _read_instructions(path: Path | None) -> str | None:
    """读提示词正文；空文件按「没有提示词」处理，不注入空指令。"""

    if path is None:
        return None
    return path.read_text(encoding="utf-8").strip() or None


def _pick_model(models: BuiltModels, model: str, *, declared_by: str) -> Model:
    """按名字取模型；名字未声明即报错。"""

    picked = models.get(model)
    if picked is None:
        known = ", ".join(models) or "（config.yaml 的 models 段是空的）"
        raise RuntimeError(f"{declared_by} 引用了未声明的模型 {model!r}；已声明的有: {known}")
    return picked


def _load_agent(
    spec: Path,
    instructions: Path | None,
    *,
    name: str,
    model: Model,
    step_store: StepStore,
    extra: Sequence[AgentCapability[Any]] = (),
) -> Agent[Any, Any]:
    """装一个 agent；``name`` 同时是它在 run 记录里的 ``agent_name``。

    ``StepPersistence`` 不带 ``run_id``：官方按 ``{agent_name}-{短 uuid}`` 逐次
    materialise，因此同一个 capability 实例被并发的多次运行共用是安全的。
    """

    return Agent.from_spec(
        _read_spec(spec),
        model=model,
        name=name,
        instructions=_read_instructions(instructions),
        capabilities=[StepPersistence(store=step_store, agent_name=name), *extra],
    )


def _build_subagents(
    definitions: Sequence[SubAgentDefinition],
    step_store: StepStore,
    models: BuiltModels,
) -> SubAgents[Any]:
    return SubAgents(
        agents=[
            SubAgent(
                _load_agent(
                    sub.spec,
                    sub.instructions,
                    name=sub.name,
                    model=_pick_model(models, sub.model, declared_by=f"子 agent {sub.name}"),
                    step_store=step_store,
                ),
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
        """跑一次运行，返回官方 AG-UI 协议的编码帧流。

        未注册的 id 抛 ``NotFound``、请求体形状不合法抛 ``ValidationFailed``，
        两者都在返回迭代器之前发生，因此调用方能拿到正常的错误响应。

        请求体里客户端给了两个 id，作用完全不同。会话 id（``threadId``）决定
        这次运行归到哪段对话，服务端照它归档。运行 id（``runId``）只是客户端
        用来把收到的事件对回自己这次请求的标签，落库时根本不看它——库里那条
        运行记录的 id 是服务端自己生成的。所以拿客户端的运行 id 去库里查一次
        运行，是查不到的。
        """

        agent = self.agents.get(agent_id)
        if agent is None:
            raise NotFound(f"未注册的 agent: {agent_id}")
        try:
            run_input = AGUIAdapter.build_run_input(body)
        except ValidationError as exc:
            raise ValidationFailed("请求体不符合 AG-UI 协议") from exc
        adapter = AGUIAdapter[Any, Any](agent=agent, run_input=run_input, accept=accept)
        return adapter.encode_stream(adapter.run_stream())


def build_agent_registry(
    definitions: Sequence[AgentDefinition],
    *,
    step_store: StepStore,
    models: BuiltModels,
) -> AgentRegistry:
    """按声明装配全部 agent。``step_store`` 与 ``models`` 无默认值。"""

    agents: dict[str, Agent[Any, Any]] = {}
    for definition in definitions:
        agents[definition.agent_id] = _load_agent(
            definition.spec,
            definition.instructions,
            name=definition.agent_id,
            model=_pick_model(models, definition.model, declared_by=f"agent {definition.agent_id}"),
            step_store=step_store,
            extra=(
                [_build_subagents(definition.subagents, step_store, models)]
                if definition.subagents
                else ()
            ),
        )
    return AgentRegistry(agents=agents)


__all__ = [
    "AgentDefinition",
    "AgentRegistry",
    "SubAgentDefinition",
    "build_agent_registry",
]
