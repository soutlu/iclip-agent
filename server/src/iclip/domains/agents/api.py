"""agent 运行的 HTTP 驱动适配器：官方 AG-UI 协议流。

两个端点：POST 发起一次运行，GET 接着读同一次运行的事件。运行本身跑在这次
HTTP 请求之外，所以客户端断开只是没人读了，运行不会被取消。

本文件只认识 starlette/fastapi 与一个注入进来的运行入口。引擎侧类型
（``pydantic_ai`` / ``pydantic_ai_harness`` / ``ag_ui``）在围栏另一侧，从这里
结构上无法 import——HTTP 与 agent 引擎的分离是机械的，不靠自觉。
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated, Protocol

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.public import Principal, require_permission

JSON_MEDIA_TYPE = "application/json"
SSE_MEDIA_TYPE = "text/event-stream"

_SSE_HEADERS = {
    "cache-control": "no-cache",
    # 反向代理默认会攒够一批再往下发，事件流会被攒住。这个头让 nginx 别缓冲。
    "x-accel-buffering": "no",
}


class Conversations(Protocol):
    """对话那一侧的入口。声明在这里而不是 import 过来：这一层只需要「有人能核对并
    记账」这件事，不需要认识对话是怎么存的。"""

    async def begin_run(
        self, *, owner: uuid.UUID, agent_id: str, conversation_id: str, run_id: str
    ) -> None:
        """核对这段对话归谁、是不是这个 agent 的，并记下这次运行。

        对不上就抛 ``NotFound``——客户端编一个会话 id 发过来，到这里就被拦住了。
        """
        ...


class AgentRuns(Protocol):
    """agent 运行的入口：发起、定位、读事件。"""

    async def open(
        self,
        *,
        owner: str,
        agent_id: str,
        body: bytes,
        deps: Callable[[str, str], Awaitable[AgentRunDeps]],
    ) -> str:
        """发起一次运行（已经在跑就什么都不做），返回它的流名字。

        ``deps`` 造出这次运行的依赖，工具执行时经 ``ctx.deps`` 取用。给的是函数
        而不是现成的对象，因为依赖里有一半在这一层还拿不到：两个 id 都在请求体
        里，而请求体是 AG-UI 协议的形状，解析它是围栏另一侧的事。所以这一层给
        身份，那一层解析出两个 id 之后回调这个函数把两半拼起来。

        它与 ``owner`` 分开传：后者只用来算流的名字，这个要一路进到运行里去。
        """
        ...

    def locate(self, *, owner: str, conversation_id: str, agent_id: str, run_id: str) -> str:
        """算出一次已有运行的流名字。"""
        ...

    async def feed(self, run_key: str, *, after: str | None) -> AsyncIterator[str]:
        """读事件；``after`` 是上次读到的位置，``None`` 即从头。"""
        ...


def _stream(frames: AsyncIterator[str]) -> Response:
    return StreamingResponse(frames, media_type=SSE_MEDIA_TYPE, headers=_SSE_HEADERS)


def create_agents_router(runs: AgentRuns, conversations: Conversations) -> APIRouter:
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

        async def deps_for(conversation_id: str, run_id: str) -> AgentRunDeps:
            """核对这段对话，记下这次运行，再把身份与对话绑成一个对象。

            身份在这里捕获一次、随运行冻结（运行脱离了这次 HTTP 请求，跑到一半
            吊销 key 不会中断它）。工具的授权与审计只认这个对象里的 principal，
            不认请求体里的任何字段。

            两个 id 由围栏另一侧解析后回调进来（它们是协议字段，归拥有协议的那一层
            管）。核对放在这里是因为它必须发生在开流之前：一旦开始发事件，再想报
            404 就只能在流中途爆开了。

            重连时这个回调会再走一遍（同一个运行 id 抢不到生产权，但请求体照样被解
            析）。所以核对必须可以重复做，而它本来就是——记的是「最近一次运行是
            谁」，重复写同一个值没有影响。
            """

            await conversations.begin_run(
                owner=principal.user_id,
                agent_id=agent_id,
                conversation_id=conversation_id,
                run_id=run_id,
            )
            return AgentRunDeps(principal=principal, conversation_id=conversation_id)

        run_key = await runs.open(
            owner=str(principal.user_id),
            agent_id=agent_id,
            body=await request.body(),
            deps=deps_for,
        )
        return _stream(await runs.feed(run_key, after=None))

    @router.get("/{agent_id}/chat/{conversation_id}/{run_id}")
    async def resume(
        agent_id: str,
        conversation_id: str,
        run_id: str,
        request: Request,
        principal: Annotated[Principal, Depends(require_permission("agent:run"))],
    ) -> Response:
        """接着读一次已经发起过的运行。

        位置优先取标准 SSE 的 ``Last-Event-ID`` 头（浏览器原生 EventSource 断
        线重连时会自动带上），没有就看 ``?from=``，两个都没有就从头重放。

        会话 id 要跟着一起给：流的名字里有它这一段，少了就拼不出来。

        这里不需要 POST 那对 CSRF 防线：读事件没有副作用，而且跨域拿不到响应
        体——我们不发 CORS 放行头。别人的运行也读不到：流名字里带着归属，换个
        人来同一组 id 就是另一条不存在的流，返回 404。
        """

        run_key = runs.locate(
            owner=str(principal.user_id),
            conversation_id=conversation_id,
            agent_id=agent_id,
            run_id=run_id,
        )
        after = request.headers.get("last-event-id") or request.query_params.get("from")
        return _stream(await runs.feed(run_key, after=after or None))

    return router


__all__ = [
    "JSON_MEDIA_TYPE",
    "SSE_MEDIA_TYPE",
    "AgentRuns",
    "Conversations",
    "create_agents_router",
]
