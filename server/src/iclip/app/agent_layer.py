"""可热换的 agent 层：模型表、agent 注册表、上下文窗口与标题模型一次装配、整体替换。

config.yaml 的 ``models`` 段、``conversations.title_model`` 与 agents/ 目录下的一切
（agents.yaml、agent.yaml、instructions.md、SKILL.md）属于这一层，运行期可以重载。
其余配置段与环境变量在启动期冻结，改了要重启。
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import structlog
from pydantic_ai import Agent
from pydantic_ai.models import Model
from pydantic_ai_harness.step_persistence import StepStore

from iclip.app.capability_table import CapabilityTable, resolve_capabilities
from iclip.config import (
    ResolvedAgent,
    ResolvedModel,
    ResolvedSettings,
    RuntimeConfig,
    SkillMount,
    resolve_settings,
)
from iclip.domains.conversations.service import GenerateTitle
from iclip.harness.agents import (
    AgentCapabilities,
    AgentDefinition,
    AgentRegistry,
    SubAgentDefinition,
    build_agent_registry,
    subagent_profiles,
)
from iclip.harness.models import BuiltModels, ModelSpec, build_model
from iclip.harness.skills import build_skill_capabilities
from iclip.harness.titles import title_generator
from iclip.harness.transcript.store import TranscriptStore
from iclip.harness.transcript.subagents import SubAgentMirror
from iclip.platform.transcript.display import ToolDisplayRegistry

_logger = structlog.stdlib.get_logger(__name__)

ReloadSource = Callable[[], tuple[RuntimeConfig, Sequence[ResolvedAgent]]]
"""重新读一遍配置与 agent 声明；由知道文件路径的一方（asgi 入口）提供。"""

HOT_SETTINGS = frozenset({"models", "title_model"})
"""ResolvedSettings 里允许热重载的字段；其余字段变了只能重启。"""


@dataclass(frozen=True, slots=True)
class LayerDeps:
    """启动期冻结、每次装配都复用的依赖。"""

    table: CapabilityTable
    step_store: StepStore
    live: TranscriptStore
    display: ToolDisplayRegistry


@dataclass(frozen=True, slots=True)
class AgentLayer:
    """一次装配的结果。``settings`` 留着给下次重载比对非热区段。"""

    settings: ResolvedSettings
    model_specs: tuple[ModelSpec, ...]
    models: BuiltModels
    registry: AgentRegistry
    context_limits: Mapping[str, int]
    generate_title: GenerateTitle


async def _no_title(_user_text: str) -> str | None:

    return None


def _capabilities(
    skills: SkillMount | None,
    names: Sequence[str],
    *,
    table: CapabilityTable,
    declared_by: str,
) -> AgentCapabilities:
    """按声明解析能力，未声明的 skill 或 capability 不挂载。"""

    mounted = build_skill_capabilities(skills.library, skills.names) if skills else ()
    return (*mounted, *resolve_capabilities(names, table=table, declared_by=declared_by))


def _agent_definitions(
    declared: Sequence[ResolvedAgent], *, table: CapabilityTable
) -> tuple[AgentDefinition, ...]:
    """将配置声明转换为 harness 入参，避免内核依赖配置层。"""

    return tuple(
        AgentDefinition(
            agent_id=agent.agent_id,
            spec=agent.spec,
            model=agent.model,
            instructions=agent.instructions,
            capabilities=_capabilities(
                agent.skills,
                agent.capabilities,
                table=table,
                declared_by=f"agent {agent.agent_id}",
            ),
            subagents=tuple(
                SubAgentDefinition(
                    name=sub.name,
                    spec=sub.spec,
                    model=sub.model,
                    instructions=sub.instructions,
                    capabilities=_capabilities(
                        sub.skills,
                        sub.capabilities,
                        table=table,
                        declared_by=f"子 agent {sub.name}",
                    ),
                    timeout_seconds=sub.timeout_seconds,
                    max_calls=sub.max_calls,
                    on_failure=sub.on_failure,
                )
                for sub in agent.subagents
            ),
        )
        for agent in declared
    )


def _model_specs(declared: Sequence[ResolvedModel]) -> tuple[ModelSpec, ...]:
    return tuple(
        ModelSpec(
            name=model.name,
            provider=model.provider,
            model=model.model,
            api=model.api,
            api_key=model.api_key,
            base_url=model.base_url,
            thinking=model.thinking,
        )
        for model in declared
    )


def _build_models(specs: Sequence[ModelSpec], previous: AgentLayer | None) -> BuiltModels:
    """声明没变的模型沿用上一层的实例，只改 agent 或 skill 时一个模型客户端都不重建。"""

    reusable: dict[ModelSpec, Model] = (
        {}
        if previous is None
        else {spec: previous.models[spec.name] for spec in previous.model_specs}
    )
    return {spec.name: reusable.get(spec) or build_model(spec) for spec in specs}


def _agent_context_limits(
    declared_agents: Sequence[ResolvedAgent],
    declared_models: Sequence[ResolvedModel],
) -> dict[str, int]:
    """只给对话顶层 agent 配窗口；子 agent 不进入 transcript 统计。"""

    limits_by_model = {
        model.name: model.context_window
        for model in declared_models
        if model.context_window is not None
    }
    return {
        agent.agent_id: limits_by_model[agent.model]
        for agent in declared_agents
        if agent.model in limits_by_model
    }


def build_agent_layer(
    settings: ResolvedSettings,
    agents: Sequence[ResolvedAgent],
    deps: LayerDeps,
    *,
    models: BuiltModels | None = None,
    previous: AgentLayer | None = None,
) -> AgentLayer:
    """完整装配一层；任何一处不合法都在这里抛出，不会留下半成品。

    ``models`` 是测试注入的替身；``previous`` 给重载复用没变的模型实例。
    """

    specs = _model_specs(settings.models)
    built_models = models if models is not None else _build_models(specs, previous)
    title_model = settings.title_model
    if title_model is None:
        generate_title: GenerateTitle = _no_title
    elif title_model not in built_models:
        raise RuntimeError(f"conversations.title_model 指向 {title_model}，models 段里没有这个名字")
    else:
        generate_title = title_generator(built_models[title_model])

    definitions = _agent_definitions(agents, table=deps.table)
    # 子代理镜像要拿到实时投影、显示表和子代理档案，装配 Agent 前先备好。
    registry = build_agent_registry(
        definitions,
        step_store=deps.step_store,
        models=built_models,
        subagent_mirror=SubAgentMirror(
            live=deps.live,
            display=deps.display,
            profiles=subagent_profiles(definitions, built_models),
        ),
    )
    return AgentLayer(
        settings=settings,
        model_specs=specs,
        models=built_models,
        registry=registry,
        context_limits=_agent_context_limits(agents, settings.models),
        generate_title=generate_title,
    )


def _changed_frozen_fields(new: ResolvedSettings, old: ResolvedSettings) -> tuple[str, ...]:
    return tuple(
        field.name
        for field in dataclasses.fields(ResolvedSettings)
        if field.name not in HOT_SETTINGS and getattr(new, field.name) != getattr(old, field.name)
    )


class CurrentAgentLayer:
    """运行期的当前 agent 层。

    替换是同步操作，asyncio 下对正在跑的协程原子；已开始的运行继续用它取到的旧对象。
    被换下的模型客户端不主动关闭：在途运行可能还在用，交给垃圾回收。
    """

    def __init__(self, layer: AgentLayer, *, deps: LayerDeps, source: ReloadSource | None) -> None:
        self._layer = layer
        self._deps = deps
        self._source = source
        self.generation = 1
        self.error: str | None = None
        self.needs_restart = False

    @property
    def current(self) -> AgentLayer:
        return self._layer

    def reload(self) -> None:
        """重新读配置并整体替换。

        失败保留旧层、记下原因，不抛出——它挂在信号处理器上，抛了没人接。
        非热区段有改动时拒绝替换并标记 ``needs_restart``，由发布脚本改走重启。
        """

        if self._source is None:
            self._fail("没有配置来源，不能热重载")
            return
        try:
            config, agents = self._source()
            settings = resolve_settings(config)
            changed = _changed_frozen_fields(settings, self._layer.settings)
            if changed:
                self._fail(
                    f"配置段 {', '.join(changed)} 有改动，要重启后端才生效", needs_restart=True
                )
                return
            layer = build_agent_layer(settings, agents, self._deps, previous=self._layer)
        except Exception as exc:
            self._fail(f"{type(exc).__name__}: {exc}")
            return
        self._layer = layer
        self.generation += 1
        self.error = None
        self.needs_restart = False
        _logger.info(
            "配置已热重载",
            generation=self.generation,
            agents=list(layer.registry.ids),
            models=list(layer.models),
        )

    def _fail(self, reason: str, *, needs_restart: bool = False) -> None:
        self.error = reason
        self.needs_restart = needs_restart
        _logger.error("配置热重载失败，继续用旧配置", reason=reason, needs_restart=needs_restart)

    def status(self) -> dict[str, object]:
        """给 /healthz 的一段：发布脚本据此判断重载成功、失败还是该重启。"""

        return {
            "generation": self.generation,
            "error": self.error,
            "needs_restart": self.needs_restart,
        }


class LiveView[K, V](Mapping[K, V]):
    """始终读当前层某个映射的只读视图；持有它的组件不用知道层被换过。"""

    def __init__(
        self, holder: CurrentAgentLayer, pick: Callable[[AgentLayer], Mapping[K, V]]
    ) -> None:
        self._holder = holder
        self._pick = pick

    def __getitem__(self, key: K) -> V:
        return self._pick(self._holder.current)[key]

    def __iter__(self) -> Iterator[K]:
        return iter(self._pick(self._holder.current))

    def __len__(self) -> int:
        return len(self._pick(self._holder.current))


def live_agents(holder: CurrentAgentLayer) -> Mapping[str, Agent[Any, Any]]:
    return LiveView(holder, lambda layer: layer.registry.agents)


def live_context_limits(holder: CurrentAgentLayer) -> Mapping[str, int]:
    return LiveView(holder, lambda layer: layer.context_limits)


def live_title_generator(holder: CurrentAgentLayer) -> GenerateTitle:
    async def generate(user_text: str) -> str | None:
        return await holder.current.generate_title(user_text)

    return generate


__all__ = [
    "HOT_SETTINGS",
    "AgentLayer",
    "CurrentAgentLayer",
    "LayerDeps",
    "ReloadSource",
    "build_agent_layer",
    "live_agents",
    "live_context_limits",
    "live_title_generator",
]
