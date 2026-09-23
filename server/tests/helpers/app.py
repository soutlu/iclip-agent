"""测试用 app 装配与 HTTP 驱动：运行配置、进程内客户端、注入身份的路由 app、开对话与等运行结束。"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import httpx
from fastapi import FastAPI, Request, Response

from iclip.app.errors import install_error_handlers
from iclip.config import (
    AppSection,
    DbSection,
    OpsSection,
    RuntimeConfig,
    SecuritySection,
    SsoSection,
)
from iclip.domains.identity.public import Principal

TEST_MODEL_NAME = "test-model"
"""集成层 ``models`` 夹具注册的替身模型名；agent 声明默认引用它。"""


def make_runtime_config() -> RuntimeConfig:
    """测试运行配置；地址与凭证由 base_env 提供。"""

    return RuntimeConfig(
        app=AppSection(name="iclip-test"),
        db=DbSection(schema="iclip"),
        security=SecuritySection(),
        sso=SsoSection(app_name="iclip"),
        ops=OpsSection(log_level="WARNING"),
    )


def make_client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def app_with_principal(granted: Principal | None) -> FastAPI:
    """只挂错误处理的空 app，每个请求都以 ``granted`` 为已解析身份；``None`` 即匿名。

    路由单测用它跳过凭证解析，调用方自己 ``include_router``。
    """

    app = FastAPI()

    @app.middleware("http")
    async def inject_principal(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # 与 PrincipalMiddleware 写入同一个 state 键，principal_of 从这里读。
        if granted is not None:
            request.state.principal = granted
        return await call_next(request)

    install_error_handlers(app)
    return app


async def new_conversation(client: httpx.AsyncClient, agent_id: str) -> str:
    """创建会话并返回 AG-UI threadId；agent 端点仅接受服务端创建的会话。"""

    created = await client.post("/conversations", json={"agentId": agent_id})
    assert created.status_code == 201, created.text
    return str(created.json()["conversation"]["id"])


async def settled(client: httpx.AsyncClient, conversation_id: str, *, tries: int = 200) -> None:
    """等会话运行结束；请求在 prompt 受理后即返回，不代表结果已持久化。同步客户端用 ws.settled。"""

    for _ in range(tries):
        queue = (await client.get(f"/conversations/{conversation_id}/prompts")).json()
        if queue["active"] is None and not queue["queued"]:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("这段对话没跑完")


__all__ = [
    "TEST_MODEL_NAME",
    "app_with_principal",
    "make_client",
    "make_runtime_config",
    "new_conversation",
    "settled",
]
