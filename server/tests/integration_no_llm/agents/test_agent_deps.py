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
from iclip.domains.identity.public import Principal
from tests.helpers.agui import run_input, sse_events
from tests.integration_no_llm.conftest import (
    TEST_MODEL_NAME,
    make_client,
    register_and_login,
    set_roles_in_db,
)

AGENT_ID = "storyboard"
URL = f"/agents/{AGENT_ID}/chat"


def identity_pack() -> tuple[AgentCapability[Principal], ...]:
    """一个只做一件事的能力包：把工具看到的主体报出来。

    工具按 ``RunContext[Principal]`` 写——这就是业务能力包里工具的形状。
    """

    def whoami(ctx: RunContext[Principal]) -> str:
        """报出当前调用方。"""

        return ctx.deps.audit_label

    return (Capability[Principal](id="identity", tools=[whoami]),)


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
            packs=("identity",),
            subagents=(),
        ),
    )


@pytest.fixture(autouse=True)
def registered_pack(monkeypatch: pytest.MonkeyPatch) -> None:
    """把上面那个包登记进名字表，让声明里的 packs: [identity] 解析得到。"""

    from iclip.app import packs

    monkeypatch.setattr(packs, "PACKS", {"identity": identity_pack})


async def whoami_said(client: httpx.AsyncClient, run_id: str) -> list[str]:
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


async def test_tool_receives_the_caller_principal(client: httpx.AsyncClient, pg_url: str) -> None:
    await register_and_login(client, username="caller-alpha", email="alpha@example.com")
    await set_roles_in_db(pg_url, "alpha@example.com", ["editor"])

    # audit_label 是 username（没有 username 才退到 email）。
    assert await whoami_said(client, "run-whoami") == ["caller-alpha"]


async def test_each_run_carries_its_own_principal(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """两个人各跑一次：各自拿到自己的主体，不是第一个人的。"""

    await register_and_login(client, username="caller-alpha", email="alpha@example.com")
    await set_roles_in_db(pg_url, "alpha@example.com", ["editor"])
    mine = await whoami_said(client, "run-mine")

    async with make_client(app) as other:
        await register_and_login(other, username="caller-beta", email="beta@example.com")
        await set_roles_in_db(pg_url, "beta@example.com", ["editor"])
        theirs = await whoami_said(other, "run-theirs")

    assert mine == ["caller-alpha"]
    assert theirs == ["caller-beta"]
