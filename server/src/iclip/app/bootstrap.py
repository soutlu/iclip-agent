"""唯一组合根：读配置、建引擎、装配模块、组 FastAPI app。"""

from __future__ import annotations

import asyncio
import signal
import uuid
from collections.abc import AsyncGenerator, Mapping, Sequence
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import httpx
import procrastinate
import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from iclip.app.agent_layer import (
    CurrentAgentLayer,
    LayerDeps,
    ReloadSource,
    build_agent_layer,
    live_agent_directory,
    live_agents,
    live_context_limits,
    live_title_generator,
    watch_and_reload,
)
from iclip.app.capability_table import build_capability_table, build_display_registry
from iclip.app.conversation_workspace import (
    ConversationWorkspace,
    validate_video_shots,
)
from iclip.app.generation_live import AnnouncingGenerationRepository
from iclip.app.logging import configure_logging
from iclip.capabilities.shot_document import SHOTS_PATH
from iclip.capabilities.shot_video.ffmpeg import ffmpeg_available
from iclip.common.errors import DomainError
from iclip.config import (
    ObjectStoreEnv,
    ResolvedAgent,
    ResolvedMediaGeneration,
    ResolvedProductCatalog,
    RuntimeConfig,
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
)
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.module import (
    GenerationModule,
    ImageModelConfig,
    build_generation_module,
)
from iclip.domains.generation.queue import GenerationQueueSettings, queue_dsn
from iclip.domains.generation.video import VideoProviderSettings
from iclip.domains.identity.accounts import CookieAuthSettings
from iclip.domains.identity.infra_sql import DB_SCHEMA
from iclip.domains.identity.middleware import PrincipalMiddleware
from iclip.domains.identity.module import SsoRuntime, build_identity_module
from iclip.domains.identity.pms import PmsUserClient
from iclip.domains.identity.sso import SsoVerifier
from iclip.domains.inspirations.infra_sql import PgInspirationVideos
from iclip.domains.inspirations.module import build_inspirations_module
from iclip.domains.inspirations.service import NoStyleDirectory
from iclip.domains.products.catalog_pg import PgStyleDirectory
from iclip.domains.tasks.infra_sql import SqlTaskRepository
from iclip.domains.tasks.module import build_tasks_module
from iclip.harness.agents import DELEGATE_TOOL
from iclip.harness.jobs import JobQueue, JobRow
from iclip.harness.models import BuiltModels
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.transcript.activity import ActivityState
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.service import TranscriptService
from iclip.harness.transcript.store import TranscriptStore
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

_logger = structlog.stdlib.get_logger(__name__)


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


def _install_hup_reload(agent_layer: CurrentAgentLayer) -> bool:
    """SIGHUP 触发热重载。装不上（非主线程、Windows）只告警，进程照常起，只是不能热重载。"""

    try:
        asyncio.get_running_loop().add_signal_handler(signal.SIGHUP, agent_layer.reload)
    except (AttributeError, NotImplementedError, RuntimeError, ValueError) as exc:
        _logger.warning("装不上 SIGHUP 处理器，配置热重载不可用", reason=str(exc))
        return False
    return True


def _require_ffmpeg(enabled: bool) -> None:
    """启动时验证 ffmpeg 与 ffprobe，避免已启用的抽帧工具在调用时才暴露部署缺失。"""

    if enabled and not ffmpeg_available():
        raise RuntimeError("启用了取帧与出图但 PATH 上找不到 ffmpeg/ffprobe：抽帧与切格都要用它")


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


def _generation_module(
    settings: ResolvedMediaGeneration,
    engine: AsyncEngine,
    *,
    database_url: str,
    object_store: PublicObjectStore,
    queue_connector: procrastinate.BaseConnector | None,
    live: LiveConnections,
) -> GenerationModule:
    """将配置解析结果转换为生成域的运行设置，保持业务域与配置层隔离。

    仓库包一层状态广播：受理与队列共用这一个实例，状态每跳一格都经它落库。"""

    return build_generation_module(
        AnnouncingGenerationRepository(SqlGenerationRepository(engine), live),
        video=VideoProviderSettings(
            submit_url=settings.video_submit_url,
            status_base_url=settings.video_status_base_url,
            api_key=settings.video_api_key,
        ),
        video_default_model=settings.video_model,
        video_allowed_models=settings.video_allowed_models,
        image_models=tuple(
            ImageModelConfig(
                name=model.name, api_base=model.api_base, concurrency=model.concurrency
            )
            for model in settings.image_models
        ),
        image_default_model=settings.image_default_model,
        image_env=settings.image_env,
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
    reload_source: ReloadSource | None = None,
    watch_paths: Sequence[Path] = (),
) -> FastAPI:
    """装配 FastAPI 应用与资源生命周期，支持注入基础设施替身。

    ``reload_source`` 重读配置与 agent 声明；``watch_paths`` 下的文件一变就用它热换 agent 层，
    SIGHUP 也触发同一次重载。两者都不给就不能热重载。
    """

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
    _require_ffmpeg(settings.shot_tools_enabled)
    if settings.shot_tools_missing:
        # 声明了 shot_video 的 Agent 会在解析能力名时报错，这里先点名缺什么。
        _logger.warning(
            "配了 shot_video 段但取帧与出图装不起来", missing=list(settings.shot_tools_missing)
        )
    # 图片信息查询、素材下载与拆解请求共用 HTTP 连接池。
    http_client = httpx.AsyncClient(follow_redirects=True)
    catalog_engine = _product_catalog_engine(settings.product_catalog, product_catalog_engine)
    owns_catalog_engine = catalog_engine is not None and product_catalog_engine is None
    # 爆款视频读自家快照表，无条件提供。降级要按品类与品牌圈选同类款，需要 PDM 款目录；
    # 缺它时降级整级失效，此处显式告警，不让调用方把「能力没开」误当成「查不到」。
    if catalog_engine is None:
        _logger.warning("未配置产品资料库，爆款视频降级不可用，未命中的款一律返回 none")
    inspirations = build_inspirations_module(
        PgInspirationVideos(active_engine),
        PgStyleDirectory(catalog_engine) if catalog_engine is not None else NoStyleDirectory(),
    )
    workspace_store = PgFileStore(active_engine)
    # 工作区写入通知依赖连接注册表。
    live_connections = LiveConnections()
    announcing_workspace_store = AnnouncingFileStore(workspace_store, live_connections)

    # 附件接收与工具能力共用素材台账，保证登记和查询一致。
    material_ledger = PgMaterialLedger(active_engine)
    conversation_workspace = ConversationWorkspace(
        workspace_store, announcing_workspace_store, material_ledger
    )

    # 镜头能力依赖生成服务，须先于 Agent 装配。
    generation = (
        _generation_module(
            settings.media_generation,
            active_engine,
            database_url=settings.database_url,
            object_store=public_objects,
            queue_connector=queue_connector,
            live=live_connections,
        )
        if settings.media_generation is not None and public_objects is not None
        else None
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

    capability_table = build_capability_table(
        workspace_store=announcing_workspace_store,
        material_ledger=material_ledger,
        http_client=http_client,
        generation_service=generation.service if generation is not None else None,
        image_models=generation.image_models if generation is not None else frozenset(),
        object_store=public_objects,
        video=settings.video,
        shot_video=settings.shot_video if settings.shot_tools_enabled else None,
    )
    # 实时与历史共用显示注册表，保证工具卡渲染一致。
    tool_displays = build_display_registry(capability_table)
    transcript_store = TranscriptStore()
    # 模型表与 agent 注册表是运行期可整体替换的一层；下面各处拿的都是读当前层的视图。
    layer_deps = LayerDeps(
        table=capability_table, step_store=step_store, live=transcript_store, display=tool_displays
    )
    agent_layer = CurrentAgentLayer(
        build_agent_layer(settings, agents, layer_deps, models=models),
        deps=layer_deps,
        source=reload_source,
    )

    conversations = build_conversations_module(
        SqlConversationRepository(active_engine),
        list_agents=live_agent_directory(agent_layer),
        purge_derived=conversation_workspace.purge,
        list_collections=list_owner_collections,
        list_derived_files=conversation_workspace.list_files,
        read_derived_file=conversation_workspace.read_file,
        write_derived_file=conversation_workspace.write_file,
        document_validators={
            SHOTS_PATH: validate_video_shots,
        },
        generate_title=live_title_generator(agent_layer),
        announce_title=live_connections.announce_title,
        activities_of=activities_of,
        conversation_ids_by_state=conversation_ids_by_state,
    )
    tasks = build_tasks_module(SqlTaskRepository(active_engine))
    assets = (
        build_assets_module(SqlAssetRepository(active_engine), public_objects)
        if public_objects is not None
        else None
    )
    job_queue = JobQueue(active_engine, on_activity=on_activity)
    context_limits = live_context_limits(agent_layer)

    async def name_conversation(row: JobRow) -> None:
        """轮次结束后调用对话命名用例，连接引擎模型与对话条件更新。"""

        await conversations.service.name_after_turn(uuid.UUID(row.conversation_id), row.text)

    async def deps_for_prompt(row: JobRow) -> AgentRunDeps:
        """按队列记录的属主重建运行主体，以开跑时的账号状态和权限执行。"""

        account = await identity.service.get_account(row.owner_user_id)
        return AgentRunDeps(
            principal=identity.service.principal_for_user(account),
            conversation_id=row.conversation_id,
            user_name=row.user_name,
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
            agents=live_agents(agent_layer),
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
        hup_installed = _install_hup_reload(agent_layer)
        stop_watching = asyncio.Event()
        watcher = (
            asyncio.create_task(
                watch_and_reload(watch_paths, agent_layer.reload, stop=stop_watching)
            )
            if watch_paths
            else None
        )
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
            if hup_installed:
                asyncio.get_running_loop().remove_signal_handler(signal.SIGHUP)
            if watcher is not None:
                stop_watching.set()
                await watcher
            if owns_catalog_engine and catalog_engine is not None:
                await catalog_engine.dispose()
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
    async def healthz() -> dict[str, object]:
        # status 恒为 ok（探活只看进程活着）；config 一段给配置发布脚本看热重载结果。
        return {"status": "ok", "config": agent_layer.status()}

    for router in identity.routers:
        app.include_router(router)
    for router in generation.routers if generation is not None else ():
        app.include_router(router)
    for router in assets.routers if assets is not None else ():
        app.include_router(router)
    for router in inspirations.routers:
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
    app.state.agent_layer = agent_layer
    app.state.conversations = conversations
    app.state.generation = generation
    app.state.inspirations = inspirations
    app.state.collections = collections
    app.state.tasks = tasks
    return app


__all__ = ["build_app"]
