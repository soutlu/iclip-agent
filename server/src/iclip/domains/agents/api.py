"""agent 运行的 HTTP 驱动适配器：官方 AG-UI 协议流。

两个端点：POST 发起一次运行，GET 接着读同一次运行的事件。运行本身跑在这次
HTTP 请求之外，所以客户端断开只是没人读了，运行不会被取消。

本文件只认识 starlette/fastapi 与一个注入进来的运行入口。引擎侧类型
（``pydantic_ai`` / ``pydantic_ai_harness`` / ``ag_ui``）在围栏另一侧，从这里
结构上无法 import——HTTP 与 agent 引擎的分离是机械的，不靠自觉。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated, Protocol

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from iclip.domains.identity.public import Principal, require_permission

JSON_MEDIA_TYPE = "application/json"
SSE_MEDIA_TYPE = "text/event-stream"

_SSE_HEADERS = {
    "cache-control": "no-cache",
    # 反向代理默认会攒够一批再往下发，事件流会被攒住。这个头让 nginx 别缓冲。
    "x-accel-buffering": "no",
}


class AgentRuns(Protocol):
    """agent 运行的入口：发起、定位、读事件。"""

    async def open(self, *, owner: str, agent_id: str, body: bytes) -> str:
        """发起一次运行（已经在跑就什么都不做），返回它的流名字。"""
        ...

    def locate(self, *, owner: str, agent_id: str, run_id: str) -> str:
        """算出一次已有运行的流名字。"""
        ...

    async def feed(self, run_key: str, *, after: str | None) -> AsyncIterator[str]:
        """读事件；``after`` 是上次读到的位置，``None`` 即从头。"""
        ...


def _stream(frames: AsyncIterator[str]) -> Response:
    return StreamingResponse(frames, media_type=SSE_MEDIA_TYPE, headers=_SSE_HEADERS)


def create_agents_router(runs: AgentRuns) -> APIRouter:
    """挂 agent 运行的两个端点；未注册的 id 由运行入口抛 NotFound → 404。"""

    router = APIRouter(prefix="/agents", tags=["agents"])

    @router.options("/{agent_id}/chat")
    async def preflight(agent_id: str) -> Response:
        """刻意不带任何 ``Access-Control-Allow-*`` 头，让跨域预检失败。

        它和 POST 上的 ``application/json`` 要求是一对 CSRF 防线：浏览器能
        跨域直接发的三种 content-type 都能塞 JSON 且不触发预检，所以要求一个
        非免检的 content-type 来强制预检，再由这里拒掉预检。任何时候都不要在
        这里加放行头——那会让用户随手打开的网页能用他的会话启动 agent 运行。
        """

        return Response(status_code=204)

    @router.post("/{agent_id}/chat")
    async def chat(
        agent_id: str,
        request: Request,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> Response:
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type != JSON_MEDIA_TYPE:
            # 在读 body、派发运行之前就挡掉：攻击者根本不需要读到响应，
            # 「运行被启动」本身就是伤害。
            return JSONResponse(
                status_code=415,
                content={"detail": f"需要 Content-Type: {JSON_MEDIA_TYPE}"},
            )
        run_key = await runs.open(
            owner=str(principal.user_id), agent_id=agent_id, body=await request.body()
        )
        return _stream(await runs.feed(run_key, after=None))

    @router.get("/{agent_id}/chat/{run_id}")
    async def resume(
        agent_id: str,
        run_id: str,
        request: Request,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> Response:
        """接着读一次已经发起过的运行。

        位置优先取标准 SSE 的 ``Last-Event-ID`` 头（浏览器原生 EventSource 断
        线重连时会自动带上），没有就看 ``?from=``，两个都没有就从头重放。

        这里不需要 POST 那对 CSRF 防线：读事件没有副作用，而且跨域拿不到响应
        体——我们不发 CORS 放行头。别人的运行也读不到：流名字里带着归属，换个
        人来同一个运行 id 就是另一条不存在的流，返回 404。
        """

        run_key = runs.locate(owner=str(principal.user_id), agent_id=agent_id, run_id=run_id)
        after = request.headers.get("last-event-id") or request.query_params.get("from")
        return _stream(await runs.feed(run_key, after=after or None))

    return router


__all__ = ["JSON_MEDIA_TYPE", "SSE_MEDIA_TYPE", "AgentRuns", "create_agents_router"]
