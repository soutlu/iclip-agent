"""唯一组合根：读配置、建引擎、装配模块、组 FastAPI app。"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from redis.asyncio import BlockingConnectionPool, Redis
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from iclip.app.logging import configure_logging
from iclip.app.packs import resolve_packs
from iclip.common.errors import DomainError
from iclip.config import (
    ResolvedAgent,
    ResolvedModel,
    ResolvedRedis,
    RuntimeConfig,
    SkillMount,
    resolve_settings,
)
from iclip.domains.agents.api import create_agents_router
from iclip.domains.identity.accounts import CookieAuthSettings
from iclip.domains.identity.infra_sql import DB_SCHEMA
from iclip.domains.identity.middleware import PrincipalMiddleware
from iclip.domains.identity.module import SsoRuntime, build_identity_module
from iclip.domains.identity.pms import PmsUserClient
from iclip.domains.identity.sso import SsoVerifier
from iclip.harness.agents import (
    AgentCapabilities,
    AgentDefinition,
    SubAgentDefinition,
    build_agent_registry,
)
from iclip.harness.models import BuiltModels, ModelSpec, build_models
from iclip.harness.run_stream_redis import RedisRunStream, RunStream
from iclip.harness.runs import RunBroker, RunStreamSettings
from iclip.harness.skills import build_skill_capabilities
from iclip.harness.step_store_pg import PgStepStore
from iclip.platform.http import status_code_for


def _capabilities(
    skills: SkillMount | None, packs: Sequence[str], *, declared_by: str
) -> AgentCapabilities:
    """把声明里的名字翻译成真的能力实例。

    skill 与能力包都是「不写即不挂」，所以两边都空就是一个空元组——这个 agent
    只有 spec 与提示词。
    """

    mounted = build_skill_capabilities(skills.library, skills.names) if skills else ()
    return (*mounted, *resolve_packs(packs, declared_by=declared_by))


def _agent_definitions(declared: Sequence[ResolvedAgent]) -> tuple[AgentDefinition, ...]:
    """把配置环的声明翻译成 harness 的入参类型。

    harness 环只依赖 common，读不到 config——这层翻译是组合根的活，
    与 identity 的 ``CookieAuthSettings`` / ``SsoRuntime`` 同一个套路。
    """

    return tuple(
        AgentDefinition(
            agent_id=agent.agent_id,
            spec=agent.spec,
            model=agent.model,
            instructions=agent.instructions,
            capabilities=_capabilities(
                agent.skills, agent.packs, declared_by=f"agent {agent.agent_id}"
            ),
            subagents=tuple(
                SubAgentDefinition(
                    name=sub.name,
                    spec=sub.spec,
                    model=sub.model,
                    instructions=sub.instructions,
                    capabilities=_capabilities(
                        sub.skills, sub.packs, declared_by=f"子 agent {sub.name}"
                    ),
                    timeout_seconds=sub.timeout_seconds,
                    max_calls=sub.max_calls,
                    on_failure=sub.on_failure,
                )
                for sub in agent.subagents
            ),
        )
        for agent in declared
    )


def _model_specs(declared: Sequence[ResolvedModel]) -> tuple[ModelSpec, ...]:
    return tuple(
        ModelSpec(
            name=model.name,
            provider=model.provider,
            model=model.model,
            api=model.api,
            api_key=model.api_key,
            base_url=model.base_url,
        )
        for model in declared
    )


_SOCKET_TIMEOUT_MARGIN = 5.0
"""socket 超时比阻塞等待多留的余量（秒）。"""


def _stream_settings(redis: ResolvedRedis | None) -> RunStreamSettings:
    """配置段缺席时（测试注入了自己的事件流）用默认时长与容量。"""

    if redis is None:
        return RunStreamSettings()
    return RunStreamSettings(
        replay_window_seconds=redis.replay_window_seconds,
        max_frames=redis.max_frames,
    )


def build_app(
    config: RuntimeConfig,
    *,
    agents: Sequence[ResolvedAgent] = (),
    engine: AsyncEngine | None = None,
    models: BuiltModels | None = None,
    run_stream: RunStream | None = None,
    sso_verifier: SsoVerifier | None = None,
    pms_client: PmsUserClient | None = None,
) -> FastAPI:
    """装配公开 app。测试可注入 engine、模型表、事件流与 SSO/PMS 协议替身。"""

    settings = resolve_settings(config)
    if settings.db_schema != DB_SCHEMA:
        raise RuntimeError(f"db.schema 当前固定为 {DB_SCHEMA}（declarative 元数据定义期绑定）")
    configure_logging(settings.log_level)

    owns_engine = engine is None
    active_engine = (
        engine
        if engine is not None
        else create_async_engine(settings.database_url, pool_pre_ping=True)
    )
    sessions = async_sessionmaker(active_engine, expire_on_commit=False)

    identity = build_identity_module(
        sessions,
        CookieAuthSettings(
            secret=settings.security.secret,
            cookie_name=settings.security.cookie_name,
            lifetime_seconds=settings.security.lifetime_seconds,
            cookie_secure=settings.security.cookie_secure,
        ),
        SsoRuntime(
            base_url=settings.sso.base_url,
            app_name=settings.sso.app_name,
            redirect_url=settings.sso.redirect_url,
            pms_base_url=settings.sso.pms_base_url,
            root_email=settings.sso.root_email,
        )
        if settings.sso is not None
        else None,
        sso_verifier=sso_verifier,
        pms_client=pms_client,
    )
    # step store 与 identity 共用同一个 engine（表在 agent_runtime schema）。
    agent_registry = build_agent_registry(
        _agent_definitions(agents),
        step_store=PgStepStore(active_engine),
        models=build_models(_model_specs(settings.models)) if models is None else models,
    )
    # 事件流只在真有 agent 时才装（同 SSO：能力没配就不挂对应路由）。
    redis_client: Redis | None = None
    broker: RunBroker | None = None
    if agents:
        stream_settings = _stream_settings(settings.redis)
        if run_stream is None:
            if settings.redis is None:
                raise RuntimeError(
                    "声明了 agent 就必须配 redis 段：运行的事件写进 Redis 才能断线重放"
                )
            redis_client = Redis(
                # 连接池满了要排队等，不能直接报错。读事件的人多是常态（每个人
                # 占住一条连接不放），而报错砸中的可能是后台运行的心跳——心跳
                # 一断，租约就过期，一个活得好好的运行会被判成中断。看的人多不
                # 该有本事把跑的人弄死。
                connection_pool=BlockingConnectionPool.from_url(
                    settings.redis.url,
                    decode_responses=True,
                    max_connections=settings.redis.max_connections,
                    # 读事件时会挂在 Redis 上等新事件，一等就是 block_ms 那么久。
                    # socket 超时必须比这个等待时间宽出一截，否则客户端会先把自己
                    # 判成超时——那正是「模型算得久、没有新事件」的正常情况。
                    socket_timeout=stream_settings.block_ms / 1000 + _SOCKET_TIMEOUT_MARGIN,
                )
            )
            run_stream = RedisRunStream(redis_client)
        broker = RunBroker(agent_registry, run_stream, stream_settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        try:
            yield
        finally:
            # 顺序要紧：后台运行还在用这个 engine 落库，先把它们收掉再关连接。
            if broker is not None:
                await broker.shutdown()
            if redis_client is not None:
                await redis_client.aclose()
            if owns_engine:
                await active_engine.dispose()

    app = FastAPI(title=settings.app_name, lifespan=lifespan)

    @app.exception_handler(DomainError)
    async def _domain_error_handler(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=status_code_for(exc),
            content={"detail": str(exc) or type(exc).__name__},
        )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    for router in identity.routers:
        app.include_router(router)
    if broker is not None:
        app.include_router(create_agents_router(broker))

    # 中间件顺序（先加的在内层）：Principal 解析在内，CORS 在外
    # （preflight 无凭证也必须被 CORS 应答）。
    app.add_middleware(PrincipalMiddleware, resolver=identity.resolver)
    if settings.security.cors_allow_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.security.cors_allow_origins),
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.state.identity = identity
    app.state.agents = agent_registry
    return app


__all__ = ["build_app"]
