"""Agent 装配与官方协议事件流：把声明变成一张冻结的 id → Agent 表。

装配在启动期完成并冻结，运行期只按 id 取用。每个 agent（含子代理）挂官方
``StepPersistence`` 落 ``step_store``，模型从传入的 ``models`` 表按名字取
（spec 里的 ``model:`` 被覆盖），能力从传入的 ``capabilities`` 挂（skill 库与
业务能力包都由组合根译好，本模块不认识它们是什么）。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from ag_ui.core import EventType
from pydantic import ValidationError
from pydantic_ai import Agent, AgentSpec
from pydantic_ai.capabilities import AgentCapability
from pydantic_ai.models import Model
from pydantic_ai.ui.ag_ui import AGUIAdapter
from pydantic_ai_harness.step_persistence import StepPersistence, StepStore
from pydantic_ai_harness.subagents import SubAgent, SubAgents

from iclip.common.errors import NotFound, ValidationFailed
from iclip.harness.models import BuiltModels

AgentCapabilities = tuple[AgentCapability[Any], ...]
"""一组待挂载的能力；具体来自 skill 还是业务能力包由组合根决定。"""


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
                    extra=sub.capabilities,
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


_TERMINAL_EVENTS = frozenset({EventType.RUN_FINISHED, EventType.RUN_ERROR})


async def _encoded_frames(
    adapter: AGUIAdapter[Any, Any], deps: object
) -> AsyncIterator[tuple[str, bool]]:
    """把协议事件逐个编码成 SSE 帧，并标出哪一帧是最后一帧。

    终帧要在编码之前从事件对象上认出来。存进流里的帧是一段不透明的文本，谁去
    读它都不该再解析一遍才知道流结束了没有。

    帧一律编码成 SSE。整条流是可重放的，重放时得给出和当初一样的字节，所以编
    码不看请求头的 ``Accept``——不能让先来的那个请求决定后来重连的人拿到什么
    格式。

    一条流最后必定有一帧终帧：官方 adapter 把运行中的异常也转成 ``RUN_ERROR``
    事件发出来，正常跑完则是 ``RUN_FINISHED``。

    ``deps`` 原样交给官方接口，工具执行时经 ``ctx.deps`` 取用。这里不看它是什
    么：宿主传什么就是什么，本模块不认识业务身份。
    """

    encoder = adapter.build_event_stream()
    async for event in adapter.run_stream(deps=deps):
        yield encoder.encode_event(event), event.type in _TERMINAL_EVENTS


@dataclass(frozen=True, slots=True)
class RunHandle:
    """一次准备好但还没开始跑的运行。

    ``run_id`` 是客户端给这次运行起的名字；``frames`` 要等有人读它才真的开跑。
    """

    run_id: str
    frames: AsyncIterator[tuple[str, bool]]


@dataclass(frozen=True, slots=True)
class AgentRegistry:
    """启动期冻结的 id → Agent 映射。"""

    agents: Mapping[str, Agent[Any, Any]]

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(self.agents)

    def start(self, agent_id: str, body: bytes, deps: object) -> RunHandle:
        """准备一次运行：校验请求，返回运行 id 和一个还没开始跑的帧流。

        未注册的 id 抛 ``NotFound``、请求体形状不合法抛 ``ValidationFailed``，
        两者都在这里就发生，还没开始产生任何事件，因此调用方能拿到正常的错误
        响应。返回的帧流要等到有人开始读它才真的把 agent 跑起来。

        请求体里客户端给了两个 id，作用完全不同。会话 id（``threadId``）决定
        这次运行归到哪段对话，服务端照它归档。运行 id（``runId``）是客户端给
        这次运行起的名字，用来把收到的事件对回自己这次请求，断线重连时也靠它
        找回同一条流；落库时不看它——库里那条运行记录的 id 是服务端自己生成
        的，所以拿客户端的运行 id 去库里查一次运行，是查不到的。

        ``deps`` 是宿主给这次运行的依赖，被返回的帧流闭包捕获，运行真正跑起来
        时交给官方接口。它是**每次运行**传进来的，不是装配期挂在 agent 上的——
        注册表是启动期冻结的共享对象，把身份挂上去就串了人。
        """

        agent = self.agents.get(agent_id)
        if agent is None:
            raise NotFound(f"未注册的 agent: {agent_id}")
        try:
            run_input = AGUIAdapter.build_run_input(body)
        except ValidationError as exc:
            raise ValidationFailed("请求体不符合 AG-UI 协议") from exc
        adapter = AGUIAdapter[Any, Any](agent=agent, run_input=run_input)
        return RunHandle(run_id=run_input.run_id, frames=_encoded_frames(adapter, deps))


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
    "AgentCapabilities",
    "AgentDefinition",
    "AgentRegistry",
    "RunHandle",
    "SubAgentDefinition",
    "build_agent_registry",
]
