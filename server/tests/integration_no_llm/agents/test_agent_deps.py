"""请求身份到工具手上：工具执行时拿到的必须是发起这次运行的那个主体。

这是工具授权与审计的地基。串错人的后果不是报错，而是 A 的运行拿着 B 的身份去
读写数据——所以这条必须走完整 HTTP 路径（真登录、真 cookie、真 principal 解析），
在替身上验不出来。

第二条尤其要紧：身份是**每次运行**传进去的，不是装配期挂在 agent 上的。注册表
是启动期冻结的共享对象，谁哪天把 deps 挪进装配，第一个用户的身份就会粘在所有
后续运行上。
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
from tests.helpers.agui import run_input, sse_events
from tests.integration_no_llm.conftest import (
    TEST_MODEL_NAME,
    make_client,
    register_and_login,
    set_roles_in_db,
)

AGENT_ID = "storyboard"
URL = f"/agents/{AGENT_ID}/chat"


def identity_capability() -> tuple[AgentCapability[AgentRunDeps], ...]:
    """一件只做一件事的能力：把工具看到的运行依赖报出来。

    工具按 ``RunContext[AgentRunDeps]`` 写——这就是能力里工具的形状。
    """

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
    """把上面那件能力登记进名字表，让声明里的 capabilities: [identity] 解析得到。

    名字表由组合根建起来（能力要拿运行期的存储后端），所以这里替的是组合根手里
    那个函数，而不是某个模块级常量。
    """

    from iclip.app import bootstrap
    from iclip.app.capability_table import CapabilityTable

    def only_identity(**_: object) -> CapabilityTable:
        return {"identity": identity_capability()}

    monkeypatch.setattr(bootstrap, "build_capability_table", only_identity)


async def tools_said(client: httpx.AsyncClient, run_id: str) -> list[str]:
    """跑一次，取出工具实际返回的那几个字。

    官方 ``test`` 模型会把每个可见工具都调一遍，所以工具的返回值以
    ``TOOL_CALL_RESULT`` 事件出现在流里。断言落在这个值上而不是「整条流里有没
    有这个子串」——后者能被任何别处出现的同名字符串蒙对（用户名互不为子串纯属
    取名的运气）。
    """

    body = run_input(thread_id=f"thread-{run_id}", run_id=run_id)
    async with client.stream("POST", URL, json=body) as response:
        assert response.status_code == 200
        raw = "".join([chunk async for chunk in response.aiter_text()])
    return [event["content"] for event in sse_events(raw) if event["type"] == "TOOL_CALL_RESULT"]


def said_by(reported: list[str], *, among: set[str]) -> list[str]:
    """从工具返回值里挑出属于某一组的那些（``test`` 模型会把每个工具都调一遍）。"""

    return [value for value in reported if value in among]


async def test_tool_receives_the_caller_principal(client: httpx.AsyncClient, pg_url: str) -> None:
    await register_and_login(client, username="caller-alpha", email="alpha@example.com")
    await set_roles_in_db(pg_url, "alpha@example.com", ["editor"])

    # audit_label 是 username（没有 username 才退到 email）。
    reported = await tools_said(client, "run-whoami")
    assert "caller-alpha" in reported
    # 对话 id 也一路到了工具手上——工作区就是按它分文件夹的。
    assert "thread-run-whoami" in reported


async def test_each_run_carries_its_own_principal(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """两个人各跑一次：各自拿到自己的主体，不是第一个人的。"""

    await register_and_login(client, username="caller-alpha", email="alpha@example.com")
    await set_roles_in_db(pg_url, "alpha@example.com", ["editor"])
    names = {"caller-alpha", "caller-beta"}
    mine = await tools_said(client, "run-mine")

    async with make_client(app) as other:
        await register_and_login(other, username="caller-beta", email="beta@example.com")
        await set_roles_in_db(pg_url, "beta@example.com", ["editor"])
        theirs = await tools_said(other, "run-theirs")

    assert said_by(mine, among=names) == ["caller-alpha"]
    assert said_by(theirs, among=names) == ["caller-beta"]
