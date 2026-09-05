"""通过完整 HTTP 登录与工具调用验证每次运行的身份隔离。

Agent 注册表为共享对象，deps 必须逐次运行传入，不能在装配时绑定首个用户。
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from pydantic_ai import RunContext
from pydantic_ai.capabilities import AgentCapability, Capability

from iclip.config import ResolvedAgent
from iclip.domains.agents.public import AgentRunDeps
from tests.integration_no_llm.agents.waiting import settled
from tests.integration_no_llm.conftest import (
    TEST_MODEL_NAME,
    make_client,
    new_conversation,
    register_and_login,
    set_roles_in_db,
)

AGENT_ID = "storyboard"


def identity_capability() -> tuple[AgentCapability[AgentRunDeps], ...]:
    """提供返回运行依赖的工具，用于验证 RunContext[AgentRunDeps] 注入。"""

    def whoami(ctx: RunContext[AgentRunDeps]) -> str:
        """报出当前调用方。"""

        return ctx.deps.principal.audit_label

    def which_conversation(ctx: RunContext[AgentRunDeps]) -> str:
        """报出这次运行所属的对话。"""

        return ctx.deps.conversation_id

    return (Capability[AgentRunDeps](id="identity", tools=[whoami, which_conversation]),)


@pytest.fixture
def agent_declarations(tmp_path: Path) -> tuple[ResolvedAgent, ...]:
    spec_dir = tmp_path / AGENT_ID
    spec_dir.mkdir(parents=True)
    spec = spec_dir / "agent.yaml"
    spec.write_text("", encoding="utf-8")
    return (
        ResolvedAgent(
            agent_id=AGENT_ID,
            spec=spec,
            instructions=None,
            model=TEST_MODEL_NAME,
            skills=None,
            capabilities=("identity",),
            subagents=(),
        ),
    )


@pytest.fixture(autouse=True)
def registered_capability(monkeypatch: pytest.MonkeyPatch) -> None:
    """替换组合根的能力表构造函数，使声明可解析测试 identity 能力。"""

    from iclip.app import bootstrap
    from iclip.app.capability_table import CapabilityTable

    def only_identity(**_: object) -> CapabilityTable:
        return {"identity": identity_capability()}

    monkeypatch.setattr(bootstrap, "build_capability_table", only_identity)


async def tools_said(
    client: httpx.AsyncClient, prompt_id: str, *, conversation_id: str | None = None
) -> list[str]:
    """直接检查工具返回值，避免整份 transcript 的子串匹配产生误报。"""

    conversation_id = conversation_id or await new_conversation(client, AGENT_ID)
    sent = await client.post(
        f"/conversations/{conversation_id}/prompts",
        json={"prompt_id": prompt_id, "content": [{"type": "text", "text": "你是谁"}]},
    )
    assert sent.status_code == 200, sent.text
    await settled(client, conversation_id)
    page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()
    return [
        str(frame["output"])
        for turn in page["items"]
        for step in turn["steps"]
        for frame in step["frames"]
        if frame["kind"] == "tool" and frame.get("output") is not None
    ]


def said_by(reported: list[str], *, among: set[str]) -> list[str]:

    return [value for value in reported if value in among]


async def test_tool_receives_the_caller_principal(client: httpx.AsyncClient, pg_url: str) -> None:
    await register_and_login(client, username="caller-alpha", email="alpha@example.com")
    await set_roles_in_db(pg_url, "alpha@example.com", ["editor"])

    conversation_id = await new_conversation(client, AGENT_ID)

    reported = await tools_said(client, "prm-whoami", conversation_id=conversation_id)
    assert "caller-alpha" in reported
    assert conversation_id in reported


async def test_each_run_carries_its_own_principal(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:

    await register_and_login(client, username="caller-alpha", email="alpha@example.com")
    await set_roles_in_db(pg_url, "alpha@example.com", ["editor"])
    names = {"caller-alpha", "caller-beta"}
    mine = await tools_said(client, "prm-mine")

    async with make_client(app) as other:
        await register_and_login(other, username="caller-beta", email="beta@example.com")
        await set_roles_in_db(pg_url, "beta@example.com", ["editor"])
        theirs = await tools_said(other, "prm-theirs")

    assert said_by(mine, among=names) == ["caller-alpha"]
    assert said_by(theirs, among=names) == ["caller-beta"]
