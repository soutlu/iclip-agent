"""唯一组合根：读配置、建引擎、装配模块、组 FastAPI app。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import Literal

import httpx
import procrastinate
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from iclip.app.capability_table import (
    CapabilityTable,
    build_capability_table,
    build_display_registry,
    resolve_capabilities,
)
from iclip.app.conversation_workspace import ConversationWorkspace, validate_video_shots
from iclip.app.logging import configure_logging
from iclip.app.task_styles import ProductStyleSnapshots, UnavailableStyleSnapshots
from iclip.capabilities.shot_video.delivery import SHOTS_PATH
from iclip.capabilities.shot_video.ffmpeg import ffmpeg_available
from iclip.common.errors import DomainError
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
    DELEGATE_TOOL,
    AgentCapabilities,
    AgentDefinition,
    SubAgentDefinition,
    build_agent_registry,
    subagent_profiles,
)
from iclip.harness.jobs import JobQueue, JobRow
from iclip.harness.models import BuiltModels, ModelSpec, build_models
from iclip.harness.skills import build_skill_capabilities
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.titles import title_generator
from iclip.harness.transcript.activity import ActivityState
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.service import TranscriptService
from iclip.harness.transcript.store import TranscriptStore
from iclip.harness.transcript.subagents import SubAgentMirror
from iclip.platform.file_store.pg import PgFileStore
from iclip.platform.file_store.store import (
    FileEntry,
    FileStore,
    SearchResult,
    StoredFile,
)
from iclip.platform.http import status_code_for
from iclip.platform.material_ledger.pg import PgMaterialLedger
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
    """按声明解析能力，未声明的 skill 或 capability 不挂载。"""

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
    """将配置声明转换为 harness 入参，避免内核依赖配置层。"""

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


def _namespace_owner(namespace: str) -> tuple[uuid.UUID, uuid.UUID] | None:
    """从工作区命名空间解析属主与对话；非对话命名空间返回 None。"""

    owner, _, conversation_id = namespace.partition("/")
    try:
        return uuid.UUID(owner), uuid.UUID(conversation_id)
    except ValueError:
        return None


class AnnouncingFileStore:
    """工作区写入后发送 event.fs.changed，存储实现与连接管理通过组合根适配。

    所有写入共用 FileStore 入口；非对话命名空间不发送通知，通知投影不影响存储结果。"""

    def __init__(self, inner: FileStore, live: LiveConnections) -> None:
        self._inner = inner
        self._live = live

    async def read(self, namespace: str, path: str) -> StoredFile | None:
        return await self._inner.read(namespace, path)

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        entry = await self._inner.write(namespace, path, content, expected_version=expected_version)
        self._announce(namespace, entry.path, "created" if entry.version == 1 else "modified")
        return entry

    async def delete(self, namespace: str, path: str) -> bool:
        deleted = await self._inner.delete(namespace, path)
        if deleted:
            self._announce(namespace, path, "deleted")
        return deleted

    def _announce(
        self, namespace: str, path: str, change: Literal["created", "modified", "deleted"]
    ) -> None:
        addressed = _namespace_owner(namespace)
        if addressed is not None:
            owner, conversation_id = addressed
            self._live.announce_fs_changed(owner, conversation_id, path=path, change=change)

    async def entries(self, namespace: str, *, prefix: str = "") -> Sequence[FileEntry]:
        return await self._inner.entries(namespace, prefix=prefix)

    async def search(self, namespace: str, query: str, *, limit: int) -> SearchResult:
        return await self._inner.search(namespace, query, limit=limit)


async def _no_title(_user_text: str) -> str | None:

    return None


def _require_ffmpeg(settings: ResolvedShotVideo | None) -> None:
    """启动时验证 ffmpeg 与 ffprobe，避免已启用的抽帧工具在调用时才暴露部署缺失。"""

    if settings is not None and not ffmpeg_available():
        raise RuntimeError("配了 shot_video 但 PATH 上找不到 ffmpeg/ffprobe：抽帧与切格都要用它")


def _product_catalog_engine(
    settings: ResolvedProductCatalog | None, injected: AsyncEngine | None
) -> AsyncEngine | None:

    if settings is None:
        return None
    return injected if injected is not None else _read_only_engine(settings.database_url)


def _read_only_engine(database_url: str) -> AsyncEngine:
    """为外部库设置会话级只读，独立于上游账号可能拥有的写权限。"""

    return create_async_engine(
        database_url,
        pool_pre_ping=True,
        connect_args={"server_settings": {"default_transaction_read_only": "on"}},
    )


def _inspirations_engine(
    settings: ResolvedInspirations | None, injected: AsyncEngine | None
) -> AsyncEngine | None:

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
    """将配置解析结果转换为生成域的运行设置，保持业务域与配置层隔离。"""

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
    """装配 FastAPI 应用与资源生命周期，支持注入基础设施替身。"""

    settings = resolve_settings(config)
    if settings.db_schema != DB_SCHEMA:
        raise RuntimeError(f"db.schema 当前固定为 {DB_SCHEMA}（declarative 元数据定义期绑定）")
    configure_logging(settings.log_level, settings.log_format)

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
    # 素材、生成与镜头能力依赖同一对象存储，先完成装配。
    public_objects = _object_store(settings.object_store, object_store)
    # 镜头能力依赖生成服务，须先于 Agent 装配。
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
    _require_ffmpeg(settings.shot_video)
    # 图片信息查询、素材下载与拆解请求共用 HTTP 连接池。
    http_client = httpx.AsyncClient(follow_redirects=True)
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
    # 工作区写入通知依赖连接注册表。
    live_connections = LiveConnections()
    announcing_workspace_store = AnnouncingFileStore(workspace_store, live_connections)

    # 附件接收与工具能力共用素材台账，保证登记和查询一致。
    material_ledger = PgMaterialLedger(active_engine)
    conversation_workspace = ConversationWorkspace(
        workspace_store, announcing_workspace_store, material_ledger
    )

    # step store、工作区与 identity 共用同一个 engine（表在 agent_runtime schema）。
    step_store = PgStepStore(
        active_engine, max_snapshots_per_run=settings.agent_runs.max_snapshots_per_run
    )
    collection_repo = SqlCollectionRepository(active_engine)
    collections = build_collections_module(collection_repo)

    async def list_owner_collections(owner: uuid.UUID) -> tuple[CollectionInfo, ...]:
        """将合集元信息适配到对话侧栏，保持两个领域独立。"""

        found = await collection_repo.list_recent(owner=owner, limit=SIDEBAR_COLLECTIONS)
        return tuple(
            CollectionInfo(id=item.id, name=item.name, updated_at=item.updated_at) for item in found
        )

    async def activities_of(
        conversation_ids: Sequence[uuid.UUID],
    ) -> Mapping[uuid.UUID, ConversationActivity]:
        """将引擎活动投影转换为对话活动模型。"""

        states = await job_queue.activities([str(one) for one in conversation_ids])
        return {
            one: ConversationActivity(
                busy=state.busy,
                pending_interaction=state.pending_interaction,
                last_turn_reason=state.last_turn_reason,
            )
            for one, state in ((one, states[str(one)]) for one in conversation_ids)
        }

    async def conversation_ids_by_state(
        owner: uuid.UUID, state: Literal["running", "done"]
    ) -> frozenset[uuid.UUID]:

        return frozenset(uuid.UUID(one) for one in await job_queue.conversation_ids(owner, state))

    def on_activity(conversation_id: str, owner: uuid.UUID, state: ActivityState) -> None:
        """同步向属主连接广播活动变化，避免 await 使连续状态通知乱序。"""

        live_connections.announce_activity(
            owner,
            uuid.UUID(conversation_id),
            busy=state.busy,
            pending_interaction=state.pending_interaction,
            last_turn_reason=state.last_turn_reason,
        )

    built_models = build_models(_model_specs(settings.models)) if models is None else models
    title_model = settings.title_model
    if title_model is None:
        generate_title: GenerateTitle = _no_title
    elif title_model not in built_models:
        raise RuntimeError(f"conversations.title_model 指向 {title_model}，models 段里没有这个名字")
    else:
        generate_title = title_generator(built_models[title_model])

    conversations = build_conversations_module(
        SqlConversationRepository(active_engine),
        purge_derived=conversation_workspace.purge,
        list_collections=list_owner_collections,
        list_derived_files=conversation_workspace.list_files,
        read_derived_file=conversation_workspace.read_file,
        write_derived_file=conversation_workspace.write_file,
        document_validators={SHOTS_PATH: validate_video_shots},
        generate_title=generate_title,
        announce_title=live_connections.announce_title,
        activities_of=activities_of,
        conversation_ids_by_state=conversation_ids_by_state,
    )
    # 缺少产品库或对象存储时，快照端口明确拒绝创建，避免写入空快照。
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
    assets = (
        build_assets_module(SqlAssetRepository(active_engine), public_objects)
        if public_objects is not None
        else None
    )
    capability_table = build_capability_table(
        workspace_store=announcing_workspace_store,
        material_ledger=material_ledger,
        http_client=http_client,
        generation_service=generation.service if generation is not None else None,
        object_store=public_objects,
        shot_video=settings.shot_video,
    )
    # 实时与历史共用显示注册表，保证工具卡渲染一致。
    tool_displays = build_display_registry(capability_table)
    transcript_store = TranscriptStore()
    agent_definitions = _agent_definitions(agents, table=capability_table)
    # 子代理镜像要拿到实时投影、显示表和子代理档案，装配 Agent 前先备好。
    agent_registry = build_agent_registry(
        agent_definitions,
        step_store=step_store,
        models=built_models,
        subagent_mirror=SubAgentMirror(
            live=transcript_store,
            display=tool_displays,
            profiles=subagent_profiles(agent_definitions, built_models),
        ),
    )
    job_queue = JobQueue(active_engine, on_activity=on_activity)
    context_limits = _agent_context_limits(agents, settings.models)

    async def name_conversation(row: JobRow) -> None:
        """轮次结束后调用对话命名用例，连接引擎模型与对话条件更新。"""

        await conversations.service.name_after_turn(uuid.UUID(row.conversation_id), row.text)

    async def deps_for_prompt(row: JobRow) -> AgentRunDeps:
        """按队列记录的属主重建运行主体，以开跑时的账号状态和权限执行。"""

        account = await identity.service.get_account(row.owner_user_id)
        return AgentRunDeps(
            principal=identity.service.principal_for_user(account),
            conversation_id=row.conversation_id,
        )

    # 显示与续跑共用历史投影，用于初始化续跑的实时状态。
    transcript_history = TranscriptHistory(step_store, job_queue, tool_displays, DELEGATE_TOOL)
    transcripts = TranscriptService(
        store=transcript_store,
        history=transcript_history,
        queue=job_queue,
        context_limits=context_limits,
        record_materials=conversation_workspace.record_materials,
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
            compaction_max_fraction=settings.compaction.max_fraction,
            compaction_keep_messages=settings.compaction.keep_messages,
            on_turn_ended=name_conversation,
            display=tool_displays,
        ),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        await transcripts.runner.start()
        if generation is not None:
            # 接收 HTTP 请求前打开队列连接。
            await generation.queue.app.open_async()
            generation.queue.start()
        try:
            yield
        finally:
            # 后台运行收尾需要落库，须先于 engine 关闭。
            if generation is not None:
                await generation.queue.stop()
                await generation.queue.app.close_async()
            # 通过框架取消运行，等待终态落库后再关闭 engine。
            await transcripts.runner.shutdown()
            await http_client.aclose()
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
