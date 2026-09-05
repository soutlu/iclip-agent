"""通过完整 app 验证组合根将声明中的 skill 装配到运行中的 Agent。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, FunctionModel

from iclip.config import ResolvedAgent, SkillMount
from tests.integration_no_llm.agents.waiting import settled
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

    return []


@pytest.fixture
def models(seen_tools: list[str]) -> dict[str, FunctionModel]:
    """通过 stream_function 记录模型实际可见工具，适配流式运行。"""

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

    conversation_id = await new_conversation(client, AGENT_ID)
    sent = await client.post(
        f"/conversations/{conversation_id}/prompts",
        json={"prompt_id": "prm_skill", "content": [{"type": "text", "text": "开始"}]},
    )
    assert sent.status_code == 200, sent.text
    await settled(client, conversation_id)

    # 正文加载与 references 读取工具需同时挂载，确保完整 skill 访问能力。
    assert "load_capability" in seen_tools
    assert "get_skill_reference" in seen_tools
