"""Agent 装配：把声明变成一张冻结的 id → Agent 表。

装配在启动期完成并冻结，运行期只按 id 取用。每个 agent（含子代理）挂官方
``StepPersistence`` 落 ``step_store``，模型从传入的 ``models`` 表按名字取
（spec 里的 ``model:`` 被覆盖），能力从传入的 ``capabilities`` 挂（skill 库与
capability 都由组合根译好，本模块不认识它们是什么）。
"""

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
"""一组待挂载的能力；具体来自 skill 还是名字表由组合根决定。"""

DELEGATE_TOOL = "delegate_task"
"""派活那件工具的名字。显式给 ``SubAgents``，好让登记 display 的那张表对得上它。"""


@dataclass(frozen=True, slots=True)
class SubAgentDefinition:
    """一条派活关系：下属的身份、spec，加这次派活的资源额度。"""

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
    """一个待注册 agent 的装配输入。``agent_id`` 会被强制成为它的 ``name``。"""

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
    accepts_deferred: bool,
    extra: Sequence[AgentCapability[Any]] = (),
    persistence_agent_name: str | None = None,
) -> Agent[Any, Any]:
    """装一个 agent。

    ``persistence_agent_name`` 决定阶段账本里的 run 用哪套 id。给了名字，官方把名字与
    ``ctx.run_id`` 编成一个不透明的 ``sp-`` 串当 run id；留空则直接用 ``ctx.run_id``，也就是
    发起方在 ``run_stream_events(run_id=...)`` 里给的那个。主 agent 必须留空：transcript 与续跑
    都按消息里的 ``run_id`` 去账本里查事件和副作用，id 对不上就整段历史查成空。

    顶层 agent 一律留空。transcript 要按 run 分轮，而分轮的依据是**消息上**的
    ``run_id``（即 ``ctx.run_id``）；官方自己铸的那个只出现在 runs/events 两张表里，与消息
    上的对不上，轮的终态就查不出来。下属留着名字：它们不进 transcript，可读的 id 更有用。

    ``accepts_deferred`` 把 ``DeferredToolRequests`` 加进输出类型，于是要审批的工具会让这次 run
    停下来结束、由运行侧记下等待并起续跑（不加官方直接报错）。**要审批的工具只挂顶层 agent**：
    派活是另起一次运行，下属那次 run 的审批会在父 run 的一次工具调用里冒出来，形状对不上运行侧
    等的那一份。

    两种情形下同一个 capability 实例被并发的多次运行共用都是安全的：``run_id`` 字段始终为空，
    实际的 id 每次 run 在 ``for_run`` 里现算。
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
        # 必须显式关掉磁盘扫描。默认值 'agents' 会扫 <cwd>/.agents|.claude/agents/
        # 以及 ~ 下的同名目录——开发者个人的 agent 定义会静默变成生产下属，
        # 同一份代码在不同机器上行为不同且不报错。子 agent 一律走显式声明。
        agent_folders=None,
        # 下属只拥有上面显式给它的能力。能力包这条路官方已经堵死：capability 挂
        # 上去的 toolset 绑在「注册了这个 capability 的那次运行」上，派活是另起
        # 一次运行，所以它结构上就不转发（连打开 inherit_tools 也不转发）。
        #
        # 真正要守的是 shared_capabilities——它是「给每个下属统一追加能力」的口
        # 子，一开就绕过声明：谁能动什么不再看 agents.yaml，而是看这里写了什么。
        # 保持空着。
        #
        # inherit_tools 影响的是直接注册在 Agent(toolsets=[...]) 上的工具。本仓
        # 的工具一律经 capability 挂载，所以它对我们没有作用面；反过来说，别把
        # 工具直接注册到 agent 上，那会把这条路打开。
    )


def delegate_display_table() -> Mapping[str, DisplayFn]:
    """派活那件工具的卡怎么画。下属名与任务正文都在它的参数里（官方 ``delegate_task``）。"""

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
    """按声明装配全部 agent。两个依赖都无默认值。"""

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
