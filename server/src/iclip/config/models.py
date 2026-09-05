"""运行配置。YAML 定义能力形状，环境变量提供地址与凭证。

EnvSettings 字段别名是环境变量清单，缺失时聚合报告变量名。
可选能力的开关为空时关闭；开启后必须提供该组全部必需变量。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Final, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)

_MIN_SECRET_LENGTH = 32

RequiredEnv = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
"""必需的环境变量值，空字符串和纯空白均视为缺失。"""

OptionalEnv = Annotated[str, StringConstraints(strip_whitespace=True)]
"""可以缺的环境变量值；缺了就是空串。"""

SSO_BASE_URL_ENV: Final = "SSO_BASE_URL"
"""SSO 的总开关：这个地址为空即整项关闭。"""

OSS_BUCKET_ENV: Final = "OSS_BUCKET"
"""公开对象存储的总开关：桶名为空即整项关闭（``/uploads/*`` 与 ``/assets/*`` 不挂载）。"""

VIDEO_SUBMIT_URL_ENV: Final = "VIDEO_SUBMIT_URL"
"""媒体生成的总开关：这个地址为空即整项关闭。"""

VIDEO_UNDERSTANDING_URL_ENV: Final = "VIDEO_UNDERSTANDING_URL"
"""镜头素材能力的总开关：这个地址为空即整项关闭（`shot_video` 不登记）。"""

PRODUCT_CATALOG_DATABASE_URL_ENV: Final = "PRODUCT_CATALOG_DATABASE_URL"
"""产品资料查询的总开关：这个连接串为空即整项关闭（`/products` 不挂载）。"""

INSPIRATION_DATABASE_URL_ENV: Final = "INSPIRATION_DATABASE_URL"
"""爆款视频查询的总开关：这个连接串为空即整项关闭（`/inspirations/*` 不挂载）。"""


class ConfigSection(BaseModel):
    """所有 YAML 段的共同约束：frozen + 未知字段即拒。"""

    model_config = ConfigDict(frozen=True, extra="forbid")


class EnvSettings(BaseSettings):
    """所有 env 段的共同约束：frozen，且只认自己声明的那几个变量。"""

    model_config = SettingsConfigDict(frozen=True, extra="ignore")


# 环境变量配置


class CoreEnv(EnvSettings):
    """任何时候都必需的两个。"""

    database_url: RequiredEnv = Field(validation_alias="DATABASE_URL")
    auth_secret: RequiredEnv = Field(validation_alias="AUTH_SECRET")

    @field_validator("database_url")
    @classmethod
    def _must_be_asyncpg(cls, value: str) -> str:
        if not value.startswith("postgresql+asyncpg://"):
            raise ValueError("必须是 postgresql+asyncpg:// 连接串")
        return value

    @field_validator("auth_secret")
    @classmethod
    def _long_enough(cls, value: str) -> str:
        if len(value) < _MIN_SECRET_LENGTH:
            raise ValueError(f"长度必须 ≥ {_MIN_SECRET_LENGTH} 字符")
        return value


class SsoEnv(EnvSettings):
    """SSO 的地址。只在 ``SSO_BASE_URL`` 非空时才构造，所以落地路由是必需的。"""

    base_url: RequiredEnv = Field(validation_alias=SSO_BASE_URL_ENV)
    redirect_url: RequiredEnv = Field(validation_alias="SSO_REDIRECT_URL")
    pms_base_url: OptionalEnv = Field("", validation_alias="PMS_BASE_URL")
    root_email: OptionalEnv = Field("", validation_alias="ROOT_EMAIL")


class ObjectStoreEnv(EnvSettings):
    """公开对象存储（阿里云 OSS）的地址与凭证。

    它自己就是一项能力（素材上传、生成结果转存、镜头帧落地都用它），所以有自己的
    开关，不挂在别人下面。变量名不带本仓前缀：对象存储的凭证不是本仓专有的东西。
    """

    bucket: RequiredEnv = Field(validation_alias=OSS_BUCKET_ENV)
    endpoint: RequiredEnv = Field(validation_alias="OSS_ENDPOINT")
    access_key_id: RequiredEnv = Field(validation_alias="OSS_ACCESS_KEY_ID")
    access_key_secret: RequiredEnv = Field(validation_alias="OSS_ACCESS_KEY_SECRET")
    public_url_base: RequiredEnv = Field(validation_alias="OSS_PUBLIC_URL_BASE")


class MediaGenerationEnv(EnvSettings):
    """两家生成接口的地址与凭证。只在总开关非空时才构造，所以这里全是必需的。

    图片那两个地址要**完整的**（含路径）：接口路由不留在仓里，这是个公开仓。
    """

    video_submit_url: RequiredEnv = Field(validation_alias=VIDEO_SUBMIT_URL_ENV)
    video_status_base_url: RequiredEnv = Field(validation_alias="VIDEO_STATUS_BASE_URL")
    video_api_key: RequiredEnv = Field(validation_alias="VIDEO_API_KEY")
    image_text_to_image_url: RequiredEnv = Field(validation_alias="IMAGE_TEXT_TO_IMAGE_URL")
    image_edit_url: RequiredEnv = Field(validation_alias="IMAGE_EDIT_URL")


class VideoUnderstandingEnv(EnvSettings):
    """视频拆解接口的地址与凭证。只在总开关非空时才构造。

    地址要完整的（含路径）：接口路由不留在仓里。
    """

    url: RequiredEnv = Field(validation_alias=VIDEO_UNDERSTANDING_URL_ENV)
    api_key: RequiredEnv = Field(validation_alias="VIDEO_UNDERSTANDING_API_KEY")


class ProductCatalogEnv(EnvSettings):
    """产品资料目录：外部只读库的连接串 + 产品图所在公开桶的前缀。

    两个一起有才有意义：查得到款却给不出图片地址，是那种「点进去才发现」的半开着。
    """

    database_url: RequiredEnv = Field(validation_alias=PRODUCT_CATALOG_DATABASE_URL_ENV)
    image_base_url: RequiredEnv = Field(validation_alias="PRODUCT_IMAGE_BASE_URL")


class InspirationEnv(EnvSettings):
    """爆款视频库：外部只读库的连接串。视频地址在行上是完整的，不用另配前缀。"""

    database_url: RequiredEnv = Field(validation_alias=INSPIRATION_DATABASE_URL_ENV)


# YAML 声明


class AppSection(ConfigSection):
    name: str


class DbSection(ConfigSection):
    db_schema: str = Field("iclip", alias="schema")

    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    @field_validator("db_schema")
    @classmethod
    def _schema_is_safe(cls, value: str) -> str:
        if not value.isidentifier():
            raise ValueError("schema 必须是合法标识符")
        return value


class SecuritySection(ConfigSection):
    session_cookie_name: str = "iclip_session"
    session_lifetime_seconds: int = 604800
    cookie_secure: bool = False
    cors_allow_origins: tuple[str, ...] = ()

    @field_validator("cors_allow_origins")
    @classmethod
    def _no_wildcard(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if "*" in value:
            raise ValueError('cors_allow_origins 禁止 "*"，必须列出精确 origin')
        return value


class SsoSection(ConfigSection):
    """SSO 里唯一不属于「地址与凭证」的东西：我们在对方那边注册的应用名。"""

    app_name: str


class ModelSection(ConfigSection):
    """一个命名模型。``provider`` 是官方 provider 名；``model`` 缺省即键名。

    ``api_key_env`` 是**这一条**用哪个变量取 key——每个模型的 key 各自一个变量，
    这属于声明的一部分，没法用一套写死的别名表达，所以它留在 YAML 里。
    """

    provider: str
    api: Literal["chat", "responses"] = "chat"
    api_key_env: str
    base_url: str | None = None
    model: str | None = None
    thinking: ThinkingEffort | None = None
    """思考强度档位；不写即不发该参数，用厂商默认档。"""
    context_window: int | None = Field(default=None, gt=0)
    """传给 Pydantic AI Harness 的模型上下文窗口。"""


ThinkingEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]

ArkReasoningEffort = Literal["minimal", "low", "medium", "high"]
"""方舟支持的思考强度；启动时拒绝其他值，避免上游静默使用默认档。"""


class VideoGenerationSection(ConfigSection):
    """视频生成里对方约定的取值。地址与 key 在 ``MediaGenerationEnv``。"""

    model: str
    user_name: str


class ImageGenerationSection(ConfigSection):
    """图像生成里对方约定的取值。地址在 ``MediaGenerationEnv``。"""

    user_name: str


class MediaGenerationSection(ConfigSection):
    """媒体生成的节奏与对方约定的取值。

    整项能力的开关在环境里（``VIDEO_SUBMIT_URL`` 为空即关闭），不在这份文件
    里。关闭时 ``/generations`` 不挂载、后台也不跑。

    只暴露两个节奏参数：查得多勤、多久算超时。并发与关停宽限是实现细节（按「纯等
    待」定的高值），默认值在 ``GenerationQueueSettings`` 里，真要调再往上抬。
    """

    video: VideoGenerationSection
    image: ImageGenerationSection
    poll_interval_seconds: int = Field(default=5, ge=1)
    job_timeout_seconds: int = Field(default=3600, ge=1)


class ShotVideoSection(ConfigSection):
    """镜头素材能力里对方约定的取值与节奏。地址与 key 在 ``VideoUnderstandingEnv``。

    这项能力**建立在媒体生成之上**：出图走生成域，帧与切格产物落生成用的那个公
    开对象存储。所以生成没开的时候它也装不起来。
    """

    understanding_model: str
    """拆解视频用对方哪个模型。"""

    understanding_thinking: ArkReasoningEffort | None = None
    """拆解模型的思考强度；不写即不发该参数，用对方默认档。"""

    understanding_fps: float | None = Field(default=None, ge=0.2, le=5)
    """拆解模型每秒看几帧；不写即不发该参数，用对方默认档（1 帧）。

    快剪片一秒切两三刀，每秒只看一帧就看不见剪辑点，时间码全压在整秒上。方舟只收
    0.2-5，装配期就拦住。
    """

    poll_interval_seconds: float = Field(default=5.0, gt=0)
    """出图之后隔多久查一次结果。"""

    dev_attempts: int = Field(default=2, ge=1)
    """先在 dev 渠道试几次。"""

    pro_attempts: int = Field(default=1, ge=0)
    """dev 试完还不成，再在 pro 渠道试几次。0 即不升级。"""

    backoff_seconds: float = Field(default=5.0, gt=0)
    """两次重试之间的起始间隔，之后逐次乘以 ``backoff_factor``。"""

    backoff_factor: float = Field(default=3.0, ge=1)
    job_timeout_seconds: float = Field(default=1800.0, gt=0)
    """一次出图工具调用总共等多久；超了就把记录 id 报回去，让人自己查。"""


class CompactionSection(ConfigSection):
    """历史压成摘要的触发线与尾巴长度。"""

    max_fraction: float = Field(default=0.85, gt=0, lt=1)
    """历史估算占到模型窗口的这个比例就压一次。"""

    keep_messages: int = Field(default=20, ge=1)
    """压完之后留几条原始消息在摘要后面。"""


class ConversationsSection(ConfigSection):
    """对话本身的设置。

    ``title_model`` 是给对话起标题的那个小模型，取 ``models`` 段的键名。不配就不起标题，
    对话一直叫默认名。
    """

    title_model: str | None = None
    compaction: CompactionSection = CompactionSection()


class AgentRunsSection(ConfigSection):
    """agent 运行租约的节奏：在跑的行按心跳续租，中断的由清扫重新认领续跑或判失败。"""

    heartbeat_seconds: int = Field(default=10, gt=0)
    """在跑的行每隔多久刷一次心跳。"""

    lease_seconds: int = Field(default=30, gt=0)
    """心跳停了多久就算失联。"""

    sweep_seconds: int = Field(default=15, gt=0)
    """每隔多久清扫一次失联的行、并叫醒没人管的队列。"""

    max_attempts: int = Field(default=2, ge=1)
    """一条 prompt 最多被认领几次。1 等于中断后只判失败，不续跑。"""

    max_snapshots_per_run: int = Field(default=3, ge=1)
    """一次 run 在库里留几份快照。每份都是全量历史，留多了对话级体积按份数翻倍。"""

    @model_validator(mode="after")
    def _lease_outlasts_a_heartbeat(self) -> AgentRunsSection:
        if self.lease_seconds <= self.heartbeat_seconds:
            raise ValueError("lease_seconds 必须大于 heartbeat_seconds")
        return self


class OpsSection(ConfigSection):
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_format: Literal["console", "json"] = "console"
    """console 给人看；json 一行一个对象，给日志平台按字段检索。"""


class RuntimeConfig(BaseSettings):
    model_config = SettingsConfigDict(frozen=True, extra="forbid")

    app: AppSection
    db: DbSection
    security: SecuritySection
    sso: SsoSection
    media_generation: MediaGenerationSection | None = None
    shot_video: ShotVideoSection | None = None
    models: dict[str, ModelSection] = Field(default_factory=dict[str, ModelSection])
    conversations: ConversationsSection = ConversationsSection()
    agent_runs: AgentRunsSection = AgentRunsSection()
    ops: OpsSection = OpsSection()

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # YAML 形状仅从文件与显式参数读取，环境值由独立解析流程处理。
        return (init_settings,)


def load_runtime_config(path: Path) -> RuntimeConfig:
    """从 YAML 加载并校验 RuntimeConfig。"""

    if not path.is_file():
        raise FileNotFoundError(f"配置文件不存在: {path}")
    source = YamlConfigSettingsSource(RuntimeConfig, yaml_file=path)
    data = source()
    if not data:
        raise ValueError(f"配置文件为空或不是 mapping: {path}")
    return RuntimeConfig(**data)


# 解析后的运行值


@dataclass(frozen=True, slots=True)
class ResolvedSecurity:
    secret: str
    cookie_name: str
    lifetime_seconds: int
    cookie_secure: bool
    cors_allow_origins: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ResolvedSso:
    base_url: str
    app_name: str
    redirect_url: str
    pms_base_url: str | None
    root_email: str | None


@dataclass(frozen=True, slots=True)
class ResolvedMediaGeneration:
    """媒体生成的运行值：env 里的地址凭证 + YAML 里的取值与节奏。"""

    video_submit_url: str
    video_status_base_url: str
    video_api_key: str
    video_model: str
    video_user_name: str
    image_text_to_image_url: str
    image_edit_url: str
    image_user_name: str
    poll_interval_seconds: int
    job_timeout_seconds: int


@dataclass(frozen=True, slots=True)
class ResolvedShotVideo:
    """镜头素材能力的运行值。"""

    understanding_url: str
    understanding_api_key: str
    understanding_model: str
    understanding_thinking: ArkReasoningEffort | None
    understanding_fps: float | None
    poll_interval_seconds: float
    dev_attempts: int
    pro_attempts: int
    backoff_seconds: float
    backoff_factor: float
    job_timeout_seconds: float


@dataclass(frozen=True, slots=True)
class ResolvedProductCatalog:
    """产品资料目录的运行值：外部只读库 + 产品图公开桶前缀。"""

    database_url: str
    image_base_url: str


@dataclass(frozen=True, slots=True)
class ResolvedInspirations:
    """爆款视频查询的运行值。"""

    database_url: str


@dataclass(frozen=True, slots=True)
class ResolvedAgentRuns:
    """agent 运行租约的节奏。"""

    heartbeat_seconds: int
    lease_seconds: int
    sweep_seconds: int
    max_attempts: int
    max_snapshots_per_run: int


@dataclass(frozen=True, slots=True)
class ResolvedCompaction:
    """历史压成摘要的触发线与尾巴长度。"""

    max_fraction: float
    keep_messages: int


@dataclass(frozen=True, slots=True)
class ResolvedModel:
    """一个命名模型解析后的装配事实。``name`` 是 agent 引用的名字。"""

    name: str
    provider: str
    model: str
    api: Literal["chat", "responses"]
    api_key: str
    base_url: str | None
    thinking: ThinkingEffort | None
    context_window: int | None


@dataclass(frozen=True, slots=True)
class ResolvedSettings:
    """启动期解析出的运行值；SSO 关闭时 ``sso is None``。"""

    app_name: str
    database_url: str
    db_schema: str
    security: ResolvedSecurity
    sso: ResolvedSso | None
    object_store: ObjectStoreEnv | None
    media_generation: ResolvedMediaGeneration | None
    shot_video: ResolvedShotVideo | None
    product_catalog: ResolvedProductCatalog | None
    inspirations: ResolvedInspirations | None
    models: tuple[ResolvedModel, ...]
    title_model: str | None
    """给对话起标题的模型名，取 ``models`` 里的一个。为空即不起标题。"""
    compaction: ResolvedCompaction
    agent_runs: ResolvedAgentRuns
    log_level: str
    log_format: Literal["console", "json"]


def _from_env[EnvT: EnvSettings](cls: type[EnvT]) -> EnvT:
    """通过环境变量构造设置，集中适配与字段构造签名不同的加载方式。"""

    return cls()  # pyright: ignore[reportCallIssue]


def _switched_on(env_name: str) -> bool:
    """先检查能力开关，再加载该组必需变量，区分未启用与配置不完整。"""

    return bool(os.environ.get(env_name, "").strip())


def _resolve_object_store() -> ObjectStoreEnv | None:
    """按桶名开关解析对象存储环境配置。"""

    if not _switched_on(OSS_BUCKET_ENV):
        return None
    return _from_env(ObjectStoreEnv)


def _resolve_media_generation(
    section: MediaGenerationSection | None, *, object_store_on: bool
) -> ResolvedMediaGeneration | None:
    """按声明与环境开关解析媒体生成；开启后必须配置全部凭证及结果转存所需的对象存储。"""

    if section is None or not _switched_on(VIDEO_SUBMIT_URL_ENV):
        return None
    if not object_store_on:
        raise RuntimeError(
            f"配了 {VIDEO_SUBMIT_URL_ENV} 但对象存储没开：图片生成结果要转存成自己的公开"
            f"对象，否则库里存的是几天后就失效的签名地址。补上 {OSS_BUCKET_ENV} 那一组"
        )
    env = _from_env(MediaGenerationEnv)
    return ResolvedMediaGeneration(
        video_submit_url=env.video_submit_url,
        video_status_base_url=env.video_status_base_url,
        video_api_key=env.video_api_key,
        video_model=section.video.model,
        video_user_name=section.video.user_name,
        image_text_to_image_url=env.image_text_to_image_url,
        image_edit_url=env.image_edit_url,
        image_user_name=section.image.user_name,
        poll_interval_seconds=section.poll_interval_seconds,
        job_timeout_seconds=section.job_timeout_seconds,
    )


def _resolve_shot_video(
    section: ShotVideoSection | None, *, generation_on: bool
) -> ResolvedShotVideo | None:
    """按声明与环境开关解析镜头能力；开启时必须同时启用媒体生成与对象存储。"""

    if section is None or not _switched_on(VIDEO_UNDERSTANDING_URL_ENV):
        return None
    if not generation_on:
        raise RuntimeError(
            f"配了 {VIDEO_UNDERSTANDING_URL_ENV} 但媒体生成没开：镜头素材能力的出图与"
            f"对象存储都走生成那一套，要么补上 {VIDEO_SUBMIT_URL_ENV}，要么把它清空"
        )
    env = _from_env(VideoUnderstandingEnv)
    return ResolvedShotVideo(
        understanding_url=env.url,
        understanding_api_key=env.api_key,
        understanding_model=section.understanding_model,
        understanding_thinking=section.understanding_thinking,
        understanding_fps=section.understanding_fps,
        poll_interval_seconds=section.poll_interval_seconds,
        dev_attempts=section.dev_attempts,
        pro_attempts=section.pro_attempts,
        backoff_seconds=section.backoff_seconds,
        backoff_factor=section.backoff_factor,
        job_timeout_seconds=section.job_timeout_seconds,
    )


def _resolve_product_catalog() -> ResolvedProductCatalog | None:
    """按数据库连接开关解析产品目录与图片公开前缀。"""

    if not _switched_on(PRODUCT_CATALOG_DATABASE_URL_ENV):
        return None
    env = _from_env(ProductCatalogEnv)
    return ResolvedProductCatalog(database_url=env.database_url, image_base_url=env.image_base_url)


def _resolve_inspirations() -> ResolvedInspirations | None:
    """按数据库连接开关解析爆款视频查询。"""

    if not _switched_on(INSPIRATION_DATABASE_URL_ENV):
        return None
    return ResolvedInspirations(database_url=_from_env(InspirationEnv).database_url)


def resolve_settings(config: RuntimeConfig) -> ResolvedSettings:
    """合并 YAML 声明与环境值，启动时校验配置完整性。"""

    core = _from_env(CoreEnv)

    sso: ResolvedSso | None = None
    if _switched_on(SSO_BASE_URL_ENV):
        env = _from_env(SsoEnv)
        sso = ResolvedSso(
            base_url=env.base_url,
            app_name=config.sso.app_name,
            redirect_url=env.redirect_url,
            pms_base_url=env.pms_base_url or None,
            root_email=env.root_email or None,
        )

    object_store = _resolve_object_store()
    media_generation = _resolve_media_generation(
        config.media_generation, object_store_on=object_store is not None
    )
    return ResolvedSettings(
        app_name=config.app.name,
        database_url=core.database_url,
        db_schema=config.db.db_schema,
        security=ResolvedSecurity(
            secret=core.auth_secret,
            cookie_name=config.security.session_cookie_name,
            lifetime_seconds=config.security.session_lifetime_seconds,
            cookie_secure=config.security.cookie_secure,
            cors_allow_origins=config.security.cors_allow_origins,
        ),
        sso=sso,
        object_store=object_store,
        media_generation=media_generation,
        shot_video=_resolve_shot_video(
            config.shot_video, generation_on=media_generation is not None
        ),
        product_catalog=_resolve_product_catalog(),
        inspirations=_resolve_inspirations(),
        models=tuple(
            ResolvedModel(
                name=name,
                provider=model.provider,
                model=model.model or name,
                api=model.api,
                api_key=_require_model_key(name, model.api_key_env),
                base_url=model.base_url,
                thinking=model.thinking,
                context_window=model.context_window,
            )
            for name, model in config.models.items()
        ),
        title_model=config.conversations.title_model,
        compaction=ResolvedCompaction(
            max_fraction=config.conversations.compaction.max_fraction,
            keep_messages=config.conversations.compaction.keep_messages,
        ),
        agent_runs=ResolvedAgentRuns(
            heartbeat_seconds=config.agent_runs.heartbeat_seconds,
            lease_seconds=config.agent_runs.lease_seconds,
            sweep_seconds=config.agent_runs.sweep_seconds,
            max_attempts=config.agent_runs.max_attempts,
            max_snapshots_per_run=config.agent_runs.max_snapshots_per_run,
        ),
        log_level=config.ops.log_level,
        log_format=config.ops.log_format,
    )


def _require_model_key(name: str, env_name: str) -> str:
    """按模型声明的环境变量名读取 API key。"""

    value = os.environ.get(env_name, "").strip()
    if not value:
        raise RuntimeError(f"缺少运行必需的环境变量 {env_name}（模型 {name} 的 API Key）")
    return value
