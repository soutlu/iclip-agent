"""Runtime Configuration：YAML 管形状，环境变量管值。

两份东西分得很清：

- **YAML 说「装什么、什么形状」** —— 声明哪些模型、哪些节奏、哪些名字。它进仓。
- **环境变量说「连到哪儿、用什么凭证」** —— 地址与密钥。它不进仓，也不该进。

env 的读取交给 pydantic-settings：每个字段用 ``validation_alias`` 写死它对应的变量
名，所以下面那几个 ``*Env`` 类**就是这个服务的环境变量清单**——想知道要配什么，看
它们就够了。缺了哪几个它会一次全报出来，报的是变量名本身，不是内部字段名。

**可选能力的开关是我们自己判断的**（那是策略，不是机械）：某个地址的 env 为空就整
项关闭；一旦非空，那一组的其余变量就都是必需的——半开着比关着更糟，路由挂上了、点
下去才发现某个地址没配。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)

_MIN_SECRET_LENGTH = 32

RequiredEnv = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
"""必需的环境变量值。**设成空串或只有空白等于没设**——那种半配置最难查。"""

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


# ── 环境变量清单 ──────────────────────────────────────────────────────────────


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


# ── YAML 的形状 ───────────────────────────────────────────────────────────────


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


ThinkingEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]

ArkReasoningEffort = Literal["minimal", "low", "medium", "high"]
"""火山方舟文档只给这四档。对方不校验取值——配了别的它照样跑、只是静默按默认档来，
所以这里在装配期就拒掉。"""


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


class ConversationsSection(ConfigSection):
    """对话本身的设置。

    ``title_model`` 是给对话起标题的那个小模型，取 ``models`` 段的键名。不配就不起标题，
    对话一直叫默认名。
    """

    title_model: str | None = None


class OpsSection(ConfigSection):
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"


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
        # 只吃 YAML（经 init kwargs 注入路径）与显式 init 值。这一份是「形状」，
        # 环境变量管的是「值」，两者不该互相覆盖。
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


# ── 装配期的运行值 ────────────────────────────────────────────────────────────


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
class ResolvedModel:
    """一个命名模型解析后的装配事实。``name`` 是 agent 引用的名字。"""

    name: str
    provider: str
    model: str
    api: Literal["chat", "responses"]
    api_key: str
    base_url: str | None
    thinking: ThinkingEffort | None


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
    log_level: str


def _from_env[EnvT: EnvSettings](cls: type[EnvT]) -> EnvT:
    """从环境变量构造一个 env 段。

    类型检查器按字段签名以为这些值该由调用方传进来，而它们本来就该由环境提供。把这
    条说明集中在这一处，而不是每个构造点各贴一条忽略。
    """

    return cls()  # pyright: ignore[reportCallIssue]


def _switched_on(env_name: str) -> bool:
    """可选能力的开关：那个地址的 env 为空就是没开。

    这一步必须在读那一组其余变量**之前**做——不然「没开这项能力」和「开了但没配
    全」就分不开了。
    """

    return bool(os.environ.get(env_name, "").strip())


def _resolve_object_store() -> ObjectStoreEnv | None:
    """解析公开对象存储；桶名为空即整项关闭。它没有 YAML 段——没有可调的形状。"""

    if not _switched_on(OSS_BUCKET_ENV):
        return None
    return _from_env(ObjectStoreEnv)


def _resolve_media_generation(
    section: MediaGenerationSection | None, *, object_store_on: bool
) -> ResolvedMediaGeneration | None:
    """解析媒体生成；没声明或总开关为空即这项能力关闭。

    一旦开启，这一组 env 就都是必需的，缺哪几个 pydantic 一次全报出来（报的是变量
    名）。对象存储也必须开着：图像接口给的是会过期的签名 URL，不转存就等于往库里写
    一批几天后失效的链接。
    """

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
    """解析镜头素材能力；没声明或总开关为空即这项能力关闭。

    开关为空就是干脆没开（哪怕 YAML 留着这一段）——真有 agent 声明要用它，装配
    期会在名字表那里报「未登记的 capability」，该响的地方会响。但开关配了、媒体
    生成却没开是「半开着」：出图与对象存储都走生成那一套，所以直接报错。
    """

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
    """解析产品资料目录；连接串为空即整项关闭（``/products`` 不挂载）。

    它没有 YAML 段：这项能力没有可调的形状，只有「连到哪儿、图片在哪个桶」两个值。
    """

    if not _switched_on(PRODUCT_CATALOG_DATABASE_URL_ENV):
        return None
    env = _from_env(ProductCatalogEnv)
    return ResolvedProductCatalog(database_url=env.database_url, image_base_url=env.image_base_url)


def _resolve_inspirations() -> ResolvedInspirations | None:
    """解析爆款视频查询；连接串为空即整项关闭。它同样没有 YAML 段——没有可调的形状。"""

    if not _switched_on(INSPIRATION_DATABASE_URL_ENV):
        return None
    return ResolvedInspirations(database_url=_from_env(InspirationEnv).database_url)


def resolve_settings(config: RuntimeConfig) -> ResolvedSettings:
    """把 YAML 的形状和环境变量的值合成装配期要用的运行值，缺什么当场失败。"""

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
            )
            for name, model in config.models.items()
        ),
        title_model=config.conversations.title_model,
        log_level=config.ops.log_level,
    )


def _require_model_key(name: str, env_name: str) -> str:
    """取某个模型的 API Key。

    这一处仍然是「按 YAML 里给的变量名去环境里取」：每个模型各自一个变量，变量名是
    声明的一部分（见 ``ModelSection.api_key_env``），没法用写死的别名表达。
    """

    value = os.environ.get(env_name, "").strip()
    if not value:
        raise RuntimeError(f"缺少运行必需的环境变量 {env_name}（模型 {name} 的 API Key）")
    return value
