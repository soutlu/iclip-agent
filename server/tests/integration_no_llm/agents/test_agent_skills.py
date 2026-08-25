"""声明面到运行面的接线：声明里挂的 skill 必须真的到达跑起来的那个 agent。

这条守的是组合根里那一行翻译（声明的名字 → 能力实例）。它两侧的环节各自都有
测试——配置环解析得出 skill 库、harness 装得出能力、注册表挂得上——但中间那
行要是被删掉，所有单测照样全绿，而线上每个 agent 都悄悄丢掉了自己的 SOP：不
报错、不降级提示，只是不照流程干活了。所以这一环必须走完整的 app。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, FunctionModel

from iclip.config import ResolvedAgent, SkillMount
from tests.helpers.agui import run_input
from tests.integration_no_llm.conftest import (
    TEST_MODEL_NAME,
    new_conversation,
    register_and_login,
    set_roles_in_db,
)

AGENT_ID = "storyboard"
SKILL = "拆解素材"


@pytest.fixture
def seen_tools() -> list[str]:
    """这次运行里模型实际看到的工具名。"""

    return []


@pytest.fixture
def models(seen_tools: list[str]) -> dict[str, FunctionModel]:
    """替掉默认的 test 替身：这里要的是「模型看到了什么」，不是它答了什么。

    必须给 ``stream_function``——运行面是流式的，只给 ``function`` 的
    ``FunctionModel`` 会让这次运行以 ``RUN_ERROR`` 收场。
    """

    async def peek(_messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
        seen_tools.extend(tool.name for tool in info.function_tools)
        yield "看完了"

    return {TEST_MODEL_NAME: FunctionModel(stream_function=peek)}


@pytest.fixture
def agent_declarations(tmp_path: Path) -> tuple[ResolvedAgent, ...]:
    spec_dir = tmp_path / AGENT_ID
    spec_dir.mkdir(parents=True)
    spec = spec_dir / "agent.yaml"
    spec.write_text("", encoding="utf-8")

    library = tmp_path / "skills"
    skill = library / SKILL
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        f"---\nname: {SKILL}\ndescription: 把参考视频拆成结构骨架。\n---\n\n照着流程做。\n",
        encoding="utf-8",
    )

    return (
        ResolvedAgent(
            agent_id=AGENT_ID,
            spec=spec,
            instructions=None,
            model=TEST_MODEL_NAME,
            skills=SkillMount(library=library, names=(SKILL,)),
            capabilities=(),
            subagents=(),
        ),
    )


async def test_declared_skill_reaches_the_running_agent(
    client: httpx.AsyncClient, pg_url: str, seen_tools: list[str]
) -> None:
    await register_and_login(client)
    await set_roles_in_db(pg_url, "luke@example.com", ["editor"])

    body = run_input(thread_id=await new_conversation(client, AGENT_ID))
    async with client.stream("POST", f"/agents/{AGENT_ID}/chat", json=body) as response:
        assert response.status_code == 200
        async for _ in response.aiter_text():
            pass

    # 官方的按需加载入口（skill 正文靠它加载）与读 references 的工具，两个都得
    # 在——只有前者说明库挂上了但读不到分支规则。
    assert "load_capability" in seen_tools
    assert "get_skill_reference" in seen_tools
