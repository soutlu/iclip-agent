"""唯一组合根：读配置、建引擎、装配模块、组 FastAPI app。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator, Mapping, Sequence
from contextlib import asynccontextmanager

import httpx
import procrastinate
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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
    ResolvedShotVideo,
    RuntimeConfig,
    SkillMount,
    resolve_settings,
)
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.agents.transcript_api import LiveConnections, create_transcript_router
from iclip.domains.assets.infra_sql import SqlAssetRepository
from iclip.domains.assets.module import build_assets_module
from iclip.domains.collections.infra_sql import SqlCollectionRepository
from iclip.domains.collections.module import build_collections_module
from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.conversations.module import build_conversations_module
from iclip.domains.conversations.service import (
    SIDEBAR_COLLECTIONS,
    CollectionInfo,
    ConversationActivity,
    DerivedFile,
    DerivedFileContent,
    GenerateTitle,
)
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
from iclip.domains.tasks.infra_sql import SqlTaskRepository
from iclip.domains.tasks.module import build_tasks_module
from iclip.domains.tasks.ports import StyleSnapshots
from iclip.harness.agents import (
    AgentCapabilities,
    AgentDefinition,
    SubAgentDefinition,
    build_agent_registry,
)
from iclip.harness.jobs import JobQueue, JobRow
from iclip.harness.models import BuiltModels, ModelSpec, build_models
from iclip.harness.skills import build_skill_capabilities
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.titles import title_generator
from iclip.harness.transcript.activity import ActivityState, merged_with_prompt
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.service import TranscriptService
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.file_store.pg import PgFileStore
from iclip.platform.file_store.store import InvalidPath
from iclip.platform.http import status_code_for
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


def _agent_context_limits(
    declared_agents: Sequence[ResolvedAgent],
    declared_models: Sequence[ResolvedModel],
) -> dict[str, int]:
    """只给对话顶层 agent 配窗口；子 agent 不进入 transcript 统计。"""

    limits_by_model = {
        model.name: model.context_window
        for model in declared_models
        if model.context_window is not None
    }
    return {
        agent.agent_id: limits_by_model[agent.model]
        for agent in declared_agents
        if agent.model in limits_by_model
    }


_SOCKET_TIMEOUT_MARGIN = 5.0
"""socket 超时比阻塞等待多留的余量（秒）。"""


async def _no_title(_user_text: str) -> str | None:
    """没配起名模型时的替身：一个名字都不起，对话保持默认名。"""

    return None


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
    collection_repo = SqlCollectionRepository(active_engine)
    collections = build_collections_module(collection_repo)

    async def list_owner_collections(owner: uuid.UUID) -> tuple[CollectionInfo, ...]:
        """侧栏拓扑里那些合集的名字。

        这条线只能接在组合根：分组、条数、每组最近几段都在对话表上算，只有「口袋叫
        什么」在合集那一侧，而两个域互相不认识。
        """

        found = await collection_repo.list_recent(owner=owner, limit=SIDEBAR_COLLECTIONS)
        return tuple(
            CollectionInfo(id=item.id, name=item.name, updated_at=item.updated_at) for item in found
        )

    live_connections = LiveConnections()
    # 活儿变了要推给属主，而 store 的回调必须是同步的（它跑在 append 的临界区里），查属主
    # 要读库。所以这里起一个任务去查再发。拿住引用：asyncio 只弱引用运行中的任务。
    announce_tasks: set[asyncio.Task[None]] = set()

    async def activities_of(
        conversation_ids: Sequence[uuid.UUID],
    ) -> Mapping[uuid.UUID, ConversationActivity]:
        """这批对话此刻各在忙什么。引擎那侧的两份事实 → 对话那侧的形状。

        库里那条占着的 prompt 与进程内存里的实时状态合成一份：只看内存的话，重启后一段还在跑、
        或者还等着人点头的对话会被报成空闲。
        """

        statuses = await job_queue.active_statuses([str(one) for one in conversation_ids])
        merged = {
            one: merged_with_prompt(transcript_store.activity(str(one)), statuses.get(str(one)))
            for one in conversation_ids
        }
        return {
            one: ConversationActivity(
                busy=state.busy, pending_interaction=state.pending_interaction
            )
            for one, state in merged.items()
        }

    async def _push_activity(conversation_id: str, state: ActivityState) -> None:
        conversation = await conversations.service.owner_of(uuid.UUID(conversation_id))
        if conversation is None:
            return
        live_connections.announce_activity(
            conversation,
            uuid.UUID(conversation_id),
            busy=state.busy,
            pending_interaction=state.pending_interaction,
        )

    def on_activity(conversation_id: str, state: ActivityState) -> None:
        """活儿变了。已经在 store 里去过抖，一轮对话只有两三次，所以这里按次查属主。"""

        task = asyncio.create_task(_push_activity(conversation_id, state))
        announce_tasks.add(task)
        task.add_done_callback(announce_tasks.discard)

    built_models = build_models(_model_specs(settings.models)) if models is None else models
    title_model = settings.title_model
    if title_model is None:
        # 没配起名模型：对话一直叫默认名，别的照跑。
        generate_title: GenerateTitle = _no_title
    elif title_model not in built_models:
        raise RuntimeError(f"conversations.title_model 指向 {title_model}，models 段里没有这个名字")
    else:
        generate_title = title_generator(built_models[title_model])

    conversations = build_conversations_module(
        SqlConversationRepository(active_engine),
        purge_derived=purge_conversation_workspace,
        list_collections=list_owner_collections,
        list_derived_files=list_conversation_files,
        read_derived_file=read_conversation_file,
        generate_title=generate_title,
        announce_title=live_connections.announce_title,
        activities_of=activities_of,
    )
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
        models=built_models,
    )
    transcript_store = TranscriptStore(on_activity=on_activity)
    job_queue = JobQueue(active_engine)
    context_limits = _agent_context_limits(agents, settings.models)

    async def name_conversation(row: JobRow) -> None:
        """一轮跑完，给还没起过名的那段对话起个名。

        接在组合根：起名字要用模型（引擎那一侧），条件写与广播在对话那一侧，两个域互相不认识。
        """

        await conversations.service.name_after_turn(uuid.UUID(row.conversation_id), row.text)

    async def deps_for_prompt(row: JobRow) -> AgentRunDeps:
        """给排到的那条 prompt 重建运行依赖。

        身份不随请求走：一条 prompt 可能排了很久才轮到，那时发起它的那个 HTTP 请求早就没了。
        行上记的是**属主 id**，到这里再按它把主体拼回来——排队期间被停用的账号因此拿不到运行，
        而权限的变动也按开跑那一刻的现状算。
        """

        account = await identity.service.get_account(row.owner_user_id)
        return AgentRunDeps(
            principal=identity.service.principal_for_user(account),
            conversation_id=row.conversation_id,
        )

    # 显示与续跑用同一份历史：续跑的投影器要按它推出的那一轮播种实时状态。
    transcript_history = TranscriptHistory(step_store, job_queue)
    transcripts = TranscriptService(
        store=transcript_store,
        history=transcript_history,
        queue=job_queue,
        context_limits=context_limits,
        runner=ConversationRunner(
            agents=dict(agent_registry.agents),
            store=transcript_store,
            queue=job_queue,
            snapshots=step_store,
            history=transcript_history,
            deps_for=deps_for_prompt,
            context_limits=context_limits,
            heartbeat_seconds=settings.agent_runs.heartbeat_seconds,
            lease_seconds=settings.agent_runs.lease_seconds,
            sweep_seconds=settings.agent_runs.sweep_seconds,
            max_attempts=settings.agent_runs.max_attempts,
            on_turn_ended=name_conversation,
        ),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        # 先清扫一次中断的 prompt 行（判失败或认领续跑），再起心跳与清扫两个循环。
        await transcripts.runner.start()
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
            # 在跑的那些走第一方取消，让它们各自把终态发出去再收；这一步必须在 engine
            # 关掉之前，收尾要落库。
            await transcripts.runner.shutdown()
            if shot_video_client is not None:
                await shot_video_client.aclose()
            if owns_catalog_engine and catalog_engine is not None:
                await catalog_engine.dispose()
            if owns_inspiration_engine and inspiration_engine is not None:
                await inspiration_engine.dispose()
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
    for router in collections.routers:
        app.include_router(router)
    for router in tasks.routers:
        app.include_router(router)
    app.include_router(
        create_transcript_router(
            transcripts,
            conversations.service,
            allowed_origins=settings.security.cors_allow_origins,
            live=live_connections,
        )
    )

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
    app.state.collections = collections
    app.state.tasks = tasks
    return app


__all__ = ["build_app"]
