"""唯一组合根：读配置、建引擎、装配模块、组 FastAPI app。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
import procrastinate
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from redis.asyncio import BlockingConnectionPool, Redis
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from iclip.app.capability_table import (
    CapabilityTable,
    build_capability_table,
    resolve_capabilities,
)
from iclip.app.logging import configure_logging
from iclip.app.task_styles import ProductStyleSnapshots, UnavailableStyleSnapshots
from iclip.capabilities.shot_video.ffmpeg import ffmpeg_available
from iclip.capabilities.workspace.scope import namespace_for
from iclip.common.errors import DomainError, ValidationFailed
from iclip.config import (
    ObjectStoreEnv,
    ResolvedAgent,
    ResolvedInspirations,
    ResolvedMediaGeneration,
    ResolvedModel,
    ResolvedProductCatalog,
    ResolvedRedis,
    ResolvedShotVideo,
    RuntimeConfig,
    SkillMount,
    resolve_settings,
)
from iclip.domains.agents.api import create_agents_router
from iclip.domains.assets.infra_sql import SqlAssetRepository
from iclip.domains.assets.module import build_assets_module
from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.conversations.module import build_conversations_module
from iclip.domains.conversations.service import DerivedFile, DerivedFileContent
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.module import GenerationModule, build_generation_module
from iclip.domains.generation.multiflow import MultiflowSettings
from iclip.domains.generation.nano_banana import NanoBananaSettings
from iclip.domains.generation.queue import GenerationQueueSettings, queue_dsn
from iclip.domains.identity.accounts import CookieAuthSettings
from iclip.domains.identity.infra_sql import DB_SCHEMA
from iclip.domains.identity.middleware import PrincipalMiddleware
from iclip.domains.identity.module import SsoRuntime, build_identity_module
from iclip.domains.identity.pms import PmsUserClient
from iclip.domains.identity.sso import SsoVerifier
from iclip.domains.inspirations.catalog_pg import PgInspirationCatalog
from iclip.domains.inspirations.module import build_inspirations_module
from iclip.domains.products.catalog_pg import PgProductCatalog
from iclip.domains.products.module import build_products_module
from iclip.domains.projects.infra_sql import SqlProjectRepository
from iclip.domains.projects.module import build_projects_module
from iclip.domains.tasks.infra_sql import SqlTaskRepository
from iclip.domains.tasks.module import build_tasks_module
from iclip.domains.tasks.ports import StyleSnapshots
from iclip.harness.agents import (
    AgentCapabilities,
    AgentDefinition,
    SubAgentDefinition,
    build_agent_registry,
)
from iclip.harness.history import HistoryReader
from iclip.harness.media import MediaCodec
from iclip.harness.models import BuiltModels, ModelSpec, build_models
from iclip.harness.run_stream_redis import RedisRunStream, RunStream
from iclip.harness.runs import RunBroker, RunStreamSettings
from iclip.harness.skills import build_skill_capabilities
from iclip.harness.step_store_pg import PgStepStore
from iclip.platform.file_store.pg import PgFileStore
from iclip.platform.file_store.store import InvalidPath
from iclip.platform.http import status_code_for
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.oss import (
    OssObjectStore,
    OssSettings,
    PublicBucket,
    PublicObjectStore,
    validate_public_url_base,
)


def _capabilities(
    skills: SkillMount | None,
    names: Sequence[str],
    *,
    table: CapabilityTable,
    declared_by: str,
) -> AgentCapabilities:
    """把声明里的名字翻译成真的能力实例。

    skill 与 capability 都是「不写即不挂」，所以两边都空就是一个空元组——这个
    agent 只有 spec 与提示词。
    """

    mounted = build_skill_capabilities(skills.library, skills.names) if skills else ()
    return (*mounted, *resolve_capabilities(names, table=table, declared_by=declared_by))


def _agent_definitions(
    declared: Sequence[ResolvedAgent], *, table: CapabilityTable
) -> tuple[AgentDefinition, ...]:
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
                agent.skills,
                agent.capabilities,
                table=table,
                declared_by=f"agent {agent.agent_id}",
            ),
            subagents=tuple(
                SubAgentDefinition(
                    name=sub.name,
                    spec=sub.spec,
                    model=sub.model,
                    instructions=sub.instructions,
                    capabilities=_capabilities(
                        sub.skills,
                        sub.capabilities,
                        table=table,
                        declared_by=f"子 agent {sub.name}",
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
            thinking=model.thinking,
        )
        for model in declared
    )


_SOCKET_TIMEOUT_MARGIN = 5.0
"""socket 超时比阻塞等待多留的余量（秒）。"""


def _shot_video_client(settings: ResolvedShotVideo | None) -> httpx.AsyncClient | None:
    """镜头素材能力取素材与调拆解接口用的连接池。

    ffmpeg 在这里检查：抽帧与切格全靠它，PATH 上没有的话那两件工具每次调用都会
    失败——那是部署环境的问题，该在启动时就说清楚，不该等模型撞上去。
    """

    if settings is None:
        return None
    if not ffmpeg_available():
        raise RuntimeError("配了 shot_video 但 PATH 上找不到 ffmpeg/ffprobe：抽帧与切格都要用它")
    return httpx.AsyncClient(follow_redirects=True)


def _stream_settings(redis: ResolvedRedis | None) -> RunStreamSettings:
    """配置段缺席时（测试注入了自己的事件流）用默认时长与容量。"""

    if redis is None:
        return RunStreamSettings()
    return RunStreamSettings(
        replay_window_seconds=redis.replay_window_seconds,
        max_frames=redis.max_frames,
    )


def _object_store(
    settings: ObjectStoreEnv | None, injected: PublicBucket | None
) -> PublicBucket | None:
    """公开对象存储：素材上传、生成结果转存、镜头帧共用这一个（测试可注入替身）。"""

    if injected is not None:
        return injected
    if settings is None:
        return None
    return OssObjectStore(
        OssSettings(
            bucket=settings.bucket,
            endpoint=settings.endpoint,
            access_key_id=settings.access_key_id,
            access_key_secret=settings.access_key_secret,
            public_url_base=validate_public_url_base(settings.public_url_base),
        )
    )


@dataclass(frozen=True, slots=True)
class _InlineMediaLanding:
    """聊天里内嵌上传的媒体落到公开桶的哪个位置。

    这条线只能接在组合根：agent 内核那一环不认识 platform，所以它只说「同一份字节
    要落回同一个地方」，落在哪个目录由这里按桶布局补上。
    """

    objects: PublicObjectStore

    async def put_inline_media(
        self, *, digest: str, ext: str, content: bytes, content_type: str
    ) -> str:
        return await self.objects.put_public_object(
            object_key=MEDIA_PATHS.chat_media(digest=digest, ext=ext),
            content=content,
            content_type=content_type,
        )


def _product_catalog_engine(
    settings: ResolvedProductCatalog | None, injected: AsyncEngine | None
) -> AsyncEngine | None:
    """产品资料目录那个库的连接；没配这项能力就没有。

    **连接在会话层就设成只读**：那个库的账号本身有写权限，而我们只该读它。把只读钉
    在自己这边，就不依赖对方的授权配置哪天有没有改对。
    """

    if settings is None:
        return None
    return injected if injected is not None else _read_only_engine(settings.database_url)


def _read_only_engine(database_url: str) -> AsyncEngine:
    """外部只读源的连接。

    **只读钉在会话层**：那些库的账号本身可能有写权限，而我们只该读它们。钉在自己
    这边就不依赖对方的授权配置哪天有没有改对。
    """

    return create_async_engine(
        database_url,
        pool_pre_ping=True,
        connect_args={"server_settings": {"default_transaction_read_only": "on"}},
    )


def _inspirations_engine(
    settings: ResolvedInspirations | None, injected: AsyncEngine | None
) -> AsyncEngine | None:
    """爆款视频库的连接；没配这项能力就没有。"""

    if settings is None:
        return None
    return injected if injected is not None else _read_only_engine(settings.database_url)


def _generation_module(
    settings: ResolvedMediaGeneration,
    engine: AsyncEngine,
    *,
    database_url: str,
    object_store: PublicObjectStore,
    queue_connector: procrastinate.BaseConnector | None,
) -> GenerationModule:
    """把配置环的运行值翻译成 generation 的入参。

    与 identity 的 ``CookieAuthSettings`` / harness 的 ``ModelSpec`` 同一个套路：
    业务模块读不到 config，翻译是组合根的活。
    """

    return build_generation_module(
        SqlGenerationRepository(engine),
        video=MultiflowSettings(
            submit_url=settings.video_submit_url,
            status_base_url=settings.video_status_base_url,
            api_key=settings.video_api_key,
            model=settings.video_model,
            user_name=settings.video_user_name,
        ),
        image=NanoBananaSettings(
            text_to_image_url=settings.image_text_to_image_url,
            image_edit_url=settings.image_edit_url,
            user_name=settings.image_user_name,
        ),
        object_store=object_store,
        queue_connector=(
            queue_connector
            if queue_connector is not None
            else procrastinate.PsycopgConnector(conninfo=queue_dsn(database_url))
        ),
        queue_settings=GenerationQueueSettings(
            poll_interval_seconds=settings.poll_interval_seconds,
            job_timeout_seconds=settings.job_timeout_seconds,
        ),
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
    object_store: PublicBucket | None = None,
    queue_connector: procrastinate.BaseConnector | None = None,
    product_catalog_engine: AsyncEngine | None = None,
    inspirations_engine: AsyncEngine | None = None,
    style_snapshots: StyleSnapshots | None = None,
) -> FastAPI:
    """装配公开 app。

    测试可注入 engine、模型表、事件流、SSO/PMS 替身、对象存储、队列连接器、产品目录库
    与爆款视频库这两个外部只读源，以及需求单要的款号快照。
    """

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
    # 公开对象存储：它自己就是一项能力（素材上传、生成结果转存、镜头帧落地都用它），
    # 配了就有，没配这几件各自不挂。它排在最前面，是因为后面几个都要用它。
    public_objects = _object_store(settings.object_store, object_store)
    # 媒体生成：配了就装，没配就整组路由不挂（同 SSO 的口径）。
    # 它排在 agent 装配之前，是因为镜头素材能力要用它的服务与对象存储。
    generation = (
        _generation_module(
            settings.media_generation,
            active_engine,
            database_url=settings.database_url,
            object_store=public_objects,
            queue_connector=queue_connector,
        )
        if settings.media_generation is not None and public_objects is not None
        else None
    )
    shot_video_client = _shot_video_client(settings.shot_video)
    catalog_engine = _product_catalog_engine(settings.product_catalog, product_catalog_engine)
    products = (
        build_products_module(
            PgProductCatalog(catalog_engine, image_base_url=settings.product_catalog.image_base_url)
        )
        if settings.product_catalog is not None and catalog_engine is not None
        else None
    )
    owns_catalog_engine = catalog_engine is not None and product_catalog_engine is None
    inspiration_engine = _inspirations_engine(settings.inspirations, inspirations_engine)
    inspirations = (
        build_inspirations_module(PgInspirationCatalog(inspiration_engine))
        if inspiration_engine is not None
        else None
    )
    owns_inspiration_engine = inspiration_engine is not None and inspirations_engine is None
    workspace_store = PgFileStore(active_engine)

    async def purge_conversation_workspace(owner: uuid.UUID, conversation_id: uuid.UUID) -> None:
        """删掉一段对话时，连带清空它在工作区里的地盘。

        这条线只能接在组合根：对话那一侧不该知道工作区的存在，工作区那一侧也不该
        知道有「对话」这种东西。这里是唯一同时认识两者的地方。
        """

        await workspace_store.purge_namespace(namespace_for(owner, str(conversation_id)))

    async def list_conversation_files(
        owner: uuid.UUID, conversation_id: uuid.UUID
    ) -> tuple[DerivedFile, ...]:
        """列出 agent 在一段对话里写下的文件，给界面上的工作区面板看。"""

        entries = await workspace_store.entries(namespace_for(owner, str(conversation_id)))
        return tuple(
            DerivedFile(
                path=entry.path,
                size_bytes=entry.size_bytes,
                version=entry.version,
                updated_at=entry.updated_at,
            )
            for entry in entries
        )

    async def read_conversation_file(
        owner: uuid.UUID, conversation_id: uuid.UUID, path: str
    ) -> DerivedFileContent | None:
        """读其中一个文件。路径是用户给的，不合语法就是 422，不能漏成 500。"""

        try:
            stored = await workspace_store.read(namespace_for(owner, str(conversation_id)), path)
        except InvalidPath as exc:
            raise ValidationFailed(str(exc)) from exc
        if stored is None:
            return None
        return DerivedFileContent(path=stored.path, content=stored.content, version=stored.version)

    # step store、工作区与 identity 共用同一个 engine（表在 agent_runtime schema）。
    step_store = PgStepStore(active_engine)
    media = MediaCodec(
        inline_store=_InlineMediaLanding(public_objects) if public_objects is not None else None
    )
    history = HistoryReader(snapshots=step_store, media=media)

    async def read_conversation_history(conversation_id: uuid.UUID) -> tuple[dict[str, Any], ...]:
        """读一段对话里发生过的消息。

        这条线同样只能接在组合根：消息落在 agent 引擎的账本里，而对话那一侧不认识
        引擎，引擎那一侧也不认识「谁的对话」。
        """

        return await history.read(str(conversation_id))

    conversations = build_conversations_module(
        SqlConversationRepository(active_engine),
        purge_derived=purge_conversation_workspace,
        read_history=read_conversation_history,
        list_derived_files=list_conversation_files,
        read_derived_file=read_conversation_file,
    )
    projects = build_projects_module(SqlProjectRepository(active_engine))
    # 创作需求单：一张自己的表，外加「按款号抄一份快照」这一件要向外借的事。产品资料库
    # 或对象存储缺一个，就借不到——那时装个只会响亮拒绝的替代品，而不是让它悄悄记空。
    tasks = build_tasks_module(
        SqlTaskRepository(active_engine),
        style_snapshots
        if style_snapshots is not None
        else (
            ProductStyleSnapshots(products.catalog, public_objects)
            if products is not None and public_objects is not None
            else UnavailableStyleSnapshots()
        ),
    )
    # 素材：表一直在（迁移建的），但没有桶就没有上传与登记这回事，整组路由不挂。
    assets = (
        build_assets_module(SqlAssetRepository(active_engine), public_objects)
        if public_objects is not None
        else None
    )
    agent_registry = build_agent_registry(
        _agent_definitions(
            agents,
            table=build_capability_table(
                workspace_store=workspace_store,
                generation_service=generation.service if generation is not None else None,
                object_store=public_objects,
                http_client=shot_video_client,
                shot_video=settings.shot_video,
            ),
        ),
        step_store=step_store,
        models=build_models(_model_specs(settings.models)) if models is None else models,
        media=media,
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
                # 一断，租约就过期，一个还在跑的运行会被判成中断。
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
        if generation is not None:
            # 队列的连接要先开：HTTP 面受理一次生成时就要往队列里排。
            await generation.queue.app.open_async()
            generation.queue.start()
        try:
            yield
        finally:
            # 顺序要紧：后台运行还在用这个 engine 落库，先把它们收掉再关连接。
            if generation is not None:
                await generation.queue.stop()
                await generation.queue.app.close_async()
            if broker is not None:
                await broker.shutdown()
            if shot_video_client is not None:
                await shot_video_client.aclose()
            if owns_catalog_engine and catalog_engine is not None:
                await catalog_engine.dispose()
            if owns_inspiration_engine and inspiration_engine is not None:
                await inspiration_engine.dispose()
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
    for router in generation.routers if generation is not None else ():
        app.include_router(router)
    for router in assets.routers if assets is not None else ():
        app.include_router(router)
    for router in products.routers if products is not None else ():
        app.include_router(router)
    for router in inspirations.routers if inspirations is not None else ():
        app.include_router(router)
    for router in conversations.routers:
        app.include_router(router)
    for router in projects.routers:
        app.include_router(router)
    for router in tasks.routers:
        app.include_router(router)
    if broker is not None:
        app.include_router(create_agents_router(broker, conversations.service))

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
    app.state.conversations = conversations
    app.state.generation = generation
    app.state.products = products
    app.state.inspirations = inspirations
    app.state.projects = projects
    app.state.tasks = tasks
    return app


__all__ = ["build_app"]
