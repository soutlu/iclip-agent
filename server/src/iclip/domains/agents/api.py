"""agent 运行的 HTTP 驱动适配器：官方 AG-UI 协议流。

本文件只认识 starlette/fastapi 与一个注入进来的事件流工厂。引擎侧类型
（``pydantic_ai`` / ``pydantic_ai_harness``）在围栏另一侧，从这里结构上
无法 import——HTTP 与 agent 引擎的分离是机械的，不靠自觉。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from iclip.domains.identity.public import Principal, require_permission

JSON_MEDIA_TYPE = "application/json"
SSE_MEDIA_TYPE = "text/event-stream"

AgentEventStream = Callable[[str, bytes, str | None], AsyncIterator[str]]
"""``(agent_id, 请求体, accept 头) -> 协议帧流``。"""


def create_agents_router(stream: AgentEventStream) -> APIRouter:
    """挂 ``/agents/{agent_id}/chat``；未注册的 id 由事件流工厂抛 NotFound → 404。"""

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
        _principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> Response:
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type != JSON_MEDIA_TYPE:
            # 在读 body、派发运行之前就挡掉：攻击者根本不需要读到响应，
            # 「运行被启动」本身就是伤害。
            return JSONResponse(
                status_code=415,
                content={"detail": f"需要 Content-Type: {JSON_MEDIA_TYPE}"},
            )
        frames = stream(agent_id, await request.body(), request.headers.get("accept"))
        return StreamingResponse(frames, media_type=SSE_MEDIA_TYPE)

    return router


__all__ = ["JSON_MEDIA_TYPE", "SSE_MEDIA_TYPE", "AgentEventStream", "create_agents_router"]
