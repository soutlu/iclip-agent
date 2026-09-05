"""启动时按声明装配并冻结 Agent 映射，注入模型、能力与 StepPersistence。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from pydantic_ai import Agent, AgentSpec
from pydantic_ai.capabilities import AgentCapability
from pydantic_ai.models import Model
from pydantic_ai.tools import DeferredToolRequests
from pydantic_ai_harness.step_persistence import StepPersistence, StepStore
from pydantic_ai_harness.subagents import SubAgent, SubAgents

from iclip.harness.models import BuiltModels
from iclip.platform.transcript.display import AgentCallDisplay, DisplayFn, ToolDisplay

AgentCapabilities = tuple[AgentCapability[Any], ...]
"""由组合根解析的能力集合。"""

DELEGATE_TOOL = "delegate_task"
"""显式指定 SubAgents 工具名，与 display 注册保持一致。"""


@dataclass(frozen=True, slots=True)
class SubAgentDefinition:
    """子代理身份、声明与调用资源限额。"""

    name: str
    spec: Path
    model: str
    instructions: Path | None = None
    capabilities: AgentCapabilities = ()
    timeout_seconds: float | None = None
    max_calls: int | None = None
    on_failure: str | None = None


@dataclass(frozen=True, slots=True)
class AgentDefinition:
    """Agent 装配输入；agent_id 同时作为 Agent.name。"""

    agent_id: str
    spec: Path
    model: str
    instructions: Path | None = None
    capabilities: AgentCapabilities = ()
    subagents: tuple[SubAgentDefinition, ...] = ()


def _read_spec(path: Path) -> AgentSpec:
    """读 spec；空文件视为没有额外声明。"""

    return AgentSpec.from_dict(yaml.safe_load(path.read_text(encoding="utf-8")) or {})


def _read_instructions(path: Path | None) -> str | None:
    """读取非空提示词，空文件不注入指令。"""

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
    accepts_deferred: bool,
    extra: Sequence[AgentCapability[Any]] = (),
    persistence_agent_name: str | None = None,
) -> Agent[Any, Any]:
    """装配 Agent。

    顶层 persistence_agent_name 留空，使持久化 run id 与消息 run_id 一致；子代理保留名称。
    审批工具仅挂顶层 Agent，并通过 accepts_deferred 启用 DeferredToolRequests。
    StepPersistence.run_id 保持为空，由 for_run 按运行计算，以支持并发复用能力实例。
    """

    return Agent.from_spec(
        _read_spec(spec),
        model=model,
        name=name,
        instructions=_read_instructions(instructions),
        output_type=[str, DeferredToolRequests] if accepts_deferred else str,
        capabilities=[
            StepPersistence(store=step_store, agent_name=persistence_agent_name),
            *extra,
        ],
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
                    accepts_deferred=False,
                    extra=sub.capabilities,
                    persistence_agent_name=sub.name,
                ),
                timeout_seconds=sub.timeout_seconds,
                max_calls=sub.max_calls,
                on_failure=sub.on_failure,
            )
            for sub in definitions
        ],
        tool_name=DELEGATE_TOOL,
        # 禁用磁盘扫描，避免个人 .agents/.claude 目录中的 Agent 定义进入运行环境。
        agent_folders=None,
        # 子代理能力仅来自显式声明；shared_capabilities 保持为空，避免隐式继承。
        # 工具统一经 capability 挂载；inherit_tools 仅影响直接注册的 toolset。
    )


def delegate_display_table() -> Mapping[str, DisplayFn]:
    """从 delegate_task 参数生成子代理工具卡。"""

    return {DELEGATE_TOOL: _delegate_display}


def _delegate_display(args: Any) -> ToolDisplay | None:
    if not isinstance(args, dict):
        return None
    name = args.get("agent_name")
    task = args.get("task")
    if not isinstance(name, str) or not name or not isinstance(task, str):
        return None
    return AgentCallDisplay(agent_name=name, prompt=task)


@dataclass(frozen=True, slots=True)
class AgentRegistry:
    """启动期冻结的 id → Agent 映射。"""

    agents: Mapping[str, Agent[Any, Any]]

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(self.agents)


def build_agent_registry(
    definitions: Sequence[AgentDefinition],
    *,
    step_store: StepStore,
    models: BuiltModels,
) -> AgentRegistry:
    """根据声明与注入依赖装配 Agent。"""

    agents: dict[str, Agent[Any, Any]] = {}
    for definition in definitions:
        agents[definition.agent_id] = _load_agent(
            definition.spec,
            definition.instructions,
            name=definition.agent_id,
            model=_pick_model(models, definition.model, declared_by=f"agent {definition.agent_id}"),
            step_store=step_store,
            accepts_deferred=True,
            extra=(
                *definition.capabilities,
                *(
                    [_build_subagents(definition.subagents, step_store, models)]
                    if definition.subagents
                    else ()
                ),
            ),
        )
    return AgentRegistry(agents=agents)


__all__ = [
    "DELEGATE_TOOL",
    "AgentCapabilities",
    "AgentDefinition",
    "AgentRegistry",
    "SubAgentDefinition",
    "build_agent_registry",
    "delegate_display_table",
]
