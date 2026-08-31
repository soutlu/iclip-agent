"""真实模型冒烟：仓内 config.yaml + agents.yaml 装出来的 agent 能真的说话。

只跑 ``make test-external``，需要 ``.env`` 里的真实 key。单测只能证明装配形状对，
端点 / key / 模型名在厂商那边成不成立，只有这一层能回答。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic_ai_harness.step_persistence import InMemoryStepStore

from iclip.config import load_agent_declarations, load_runtime_config, resolve_settings
from iclip.harness.agents import (
    AgentDefinition,
    AgentRegistry,
    SubAgentDefinition,
    build_agent_registry,
)
from iclip.harness.models import ModelSpec, build_models

SERVER_DIR = Path(__file__).resolve().parents[3]


@pytest.fixture
def shipped_registry() -> AgentRegistry:
    settings = resolve_settings(load_runtime_config(SERVER_DIR / "configs" / "config.yaml"))
    if not settings.models:
        pytest.skip("config.yaml 未声明任何模型")
    declared = load_agent_declarations(SERVER_DIR / "agents" / "agents.yaml")
    return build_agent_registry(
        tuple(
            AgentDefinition(
                agent_id=agent.agent_id,
                spec=agent.spec,
                model=agent.model,
                instructions=agent.instructions,
                subagents=tuple(
                    SubAgentDefinition(
                        name=sub.name,
                        spec=sub.spec,
                        model=sub.model,
                        instructions=sub.instructions,
                        timeout_seconds=sub.timeout_seconds,
                        max_calls=sub.max_calls,
                        on_failure=sub.on_failure,
                    )
                    for sub in agent.subagents
                ),
            )
            for agent in declared
        ),
        step_store=InMemoryStepStore(),
        models=build_models(
            tuple(
                ModelSpec(
                    name=model.name,
                    provider=model.provider,
                    model=model.model,
                    api=model.api,
                    api_key=model.api_key,
                    base_url=model.base_url,
                )
                for model in settings.models
            )
        ),
    )


async def test_shipped_agents_answer(shipped_registry: AgentRegistry) -> None:
    for agent_id in shipped_registry.ids:
        result = await shipped_registry.agents[agent_id].run("只回复两个字：收到")
        assert result.output.strip(), f"{agent_id} 返回了空回复"
