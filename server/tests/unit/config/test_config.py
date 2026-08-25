"""配置加载与环境解析的失败即失败契约。

YAML 只管形状，值一律来自环境变量。所以这一份里的 YAML 片段不含任何变量名（只有
``models.*.api_key_env`` 例外——每个模型各自一把 key，用哪个变量取是声明的一部分）。

**每条测试之前先把这个服务认的环境变量全清掉**：变量名现在是写死的真名字，开发机
上要是恰好导出过同名变量，测试就会读到真值而不是这条测试想要的值。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from iclip.config import ResolvedSettings, RuntimeConfig, load_runtime_config, resolve_settings

DB_URL = "postgresql+asyncpg://x"

MANIFEST = (
    "DATABASE_URL",
    "AUTH_SECRET",
    "SSO_BASE_URL",
    "SSO_REDIRECT_URL",
    "PMS_BASE_URL",
    "ROOT_EMAIL",
    "REDIS_URL",
    "VIDEO_SUBMIT_URL",
    "VIDEO_STATUS_BASE_URL",
    "VIDEO_API_KEY",
    "IMAGE_TEXT_TO_IMAGE_URL",
    "IMAGE_EDIT_URL",
    "OSS_BUCKET",
    "OSS_ENDPOINT",
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
    "OSS_PUBLIC_URL_BASE",
    "VIDEO_UNDERSTANDING_URL",
    "VIDEO_UNDERSTANDING_API_KEY",
    "PRODUCT_CATALOG_DATABASE_URL",
    "PRODUCT_IMAGE_BASE_URL",
    "INSPIRATION_DATABASE_URL",
    "T_QWEN_KEY",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in MANIFEST:
        monkeypatch.delenv(name, raising=False)


VALID = """
app: {name: t}
db: {schema: iclip}
security: {}
sso: {app_name: iclip}
ops: {log_level: INFO}
"""


def write(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "config.yaml"
    path.write_text(content, encoding="utf-8")
    return path


def _core(monkeypatch: pytest.MonkeyPatch) -> None:
    """必需的那两个，供只关心别处的测试用。"""

    monkeypatch.setenv("DATABASE_URL", DB_URL)
    monkeypatch.setenv("AUTH_SECRET", "s" * 32)


def test_valid_config_loads(tmp_path: Path) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    assert config.app.name == "t"
    assert config.db.db_schema == "iclip"


def test_the_shipped_config_file_still_loads() -> None:
    """仓里那份 ``configs/config.yaml`` 必须能被现在的模型加载。

    ``extra="forbid"`` 意味着留一个过时的键就会在启动时炸——而那种错误只在真启动
    时才暴露，本地测试全绿。所以这一条专门盯着那个文件本身。
    """

    shipped = Path(__file__).resolve().parents[3] / "configs" / "config.yaml"
    config = load_runtime_config(shipped)

    assert config.app.name
    assert config.media_generation is not None, "仓里这份是开着媒体生成的"
    assert config.models, "至少要声明一个模型"


def test_unknown_key_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        load_runtime_config(write(tmp_path, VALID + "\nextra_section: {}\n"))


def test_env_var_names_are_not_accepted_in_yaml(tmp_path: Path) -> None:
    """变量名不该再出现在 YAML 里：那是旧写法，留着会让人以为它还起作用。"""

    with pytest.raises(ValidationError):
        load_runtime_config(
            write(tmp_path, VALID.replace("db: {schema: iclip}", "db: {url_env: X}"))
        )


def test_cors_wildcard_rejected(tmp_path: Path) -> None:
    bad = VALID.replace("security: {}", 'security: {cors_allow_origins: ["*"]}')
    with pytest.raises(ValidationError):
        load_runtime_config(write(tmp_path, bad))


def test_missing_file_fails(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_runtime_config(tmp_path / "absent.yaml")


def test_resolve_names_every_missing_variable_at_once(tmp_path: Path) -> None:
    """缺了几个就一次报几个，而且报的是变量名本身——一个一个试太费时间。"""

    config = load_runtime_config(write(tmp_path, VALID))
    with pytest.raises(ValidationError) as caught:
        resolve_settings(config)

    message = str(caught.value)
    assert "DATABASE_URL" in message
    assert "AUTH_SECRET" in message


def test_resolve_rejects_non_asyncpg_url(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    monkeypatch.setenv("AUTH_SECRET", "s" * 32)
    with pytest.raises(ValidationError, match="asyncpg"):
        resolve_settings(config)


def test_resolve_rejects_short_secret(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    monkeypatch.setenv("DATABASE_URL", DB_URL)
    monkeypatch.setenv("AUTH_SECRET", "short")
    with pytest.raises(ValidationError, match="32"):
        resolve_settings(config)


def test_blank_value_counts_as_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """设成空串或空白等于没设：那种半配置最难查。"""

    config = load_runtime_config(write(tmp_path, VALID))
    monkeypatch.setenv("DATABASE_URL", DB_URL)
    monkeypatch.setenv("AUTH_SECRET", "   ")
    with pytest.raises(ValidationError, match="AUTH_SECRET"):
        resolve_settings(config)


def test_sso_off_when_env_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """开关在环境里：地址为空就整项关闭，而不是半开着。"""

    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    assert resolve_settings(config).sso is None


def test_sso_on_requires_redirect(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.setenv("SSO_BASE_URL", "https://sso.test")
    with pytest.raises(ValidationError, match="SSO_REDIRECT_URL"):
        resolve_settings(config)

    monkeypatch.setenv("SSO_REDIRECT_URL", "https://app.test/auth/sso/landing")
    monkeypatch.setenv("PMS_BASE_URL", "https://pms.test")
    resolved = resolve_settings(config)
    assert resolved.sso is not None
    assert resolved.sso.pms_base_url == "https://pms.test"
    assert resolved.sso.app_name == "iclip", "应用名来自 YAML，不是环境变量"


MODELS = """
models:
  qwen3.8-max:
    provider: alibaba
    api: responses
    api_key_env: T_QWEN_KEY
    base_url: https://dashscope.test/v1
"""


def resolve_with_base(config: RuntimeConfig, monkeypatch: pytest.MonkeyPatch) -> ResolvedSettings:
    _core(monkeypatch)
    return resolve_settings(config)


def test_no_models_section_means_no_models(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert resolve_with_base(load_runtime_config(write(tmp_path, VALID)), monkeypatch).models == ()


def test_model_key_requires_its_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """模型的 key 仍然是「按声明里给的变量名去取」，缺了要报出是哪个变量。"""

    config = load_runtime_config(write(tmp_path, VALID + MODELS))
    with pytest.raises(RuntimeError, match="T_QWEN_KEY"):
        resolve_with_base(config, monkeypatch)


def test_model_key_name_is_the_model_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """键名即模型名。"""

    monkeypatch.setenv("T_QWEN_KEY", "sk-test")
    (model,) = resolve_with_base(
        load_runtime_config(write(tmp_path, VALID + MODELS)), monkeypatch
    ).models

    assert (model.name, model.model) == ("qwen3.8-max", "qwen3.8-max")
    assert (model.provider, model.api) == ("alibaba", "responses")
    assert (model.api_key, model.base_url) == ("sk-test", "https://dashscope.test/v1")


def test_explicit_model_overrides_key_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """键名不是模型名时，用 model 字段指明真实模型名。"""

    monkeypatch.setenv("T_QWEN_KEY", "sk-test")
    yaml_text = VALID + MODELS.replace("  qwen3.8-max:", "  qwen-intl:").replace(
        "    provider: alibaba", "    model: qwen3.8-max\n    provider: alibaba"
    )
    (model,) = resolve_with_base(
        load_runtime_config(write(tmp_path, yaml_text)), monkeypatch
    ).models

    assert (model.name, model.model) == ("qwen-intl", "qwen3.8-max")


def test_api_defaults_to_chat(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("T_QWEN_KEY", "sk-test")
    yaml_text = VALID + MODELS.replace("    api: responses\n", "")
    (model,) = resolve_with_base(
        load_runtime_config(write(tmp_path, yaml_text)), monkeypatch
    ).models

    assert model.api == "chat"


def test_unknown_api_value_rejected(tmp_path: Path) -> None:
    bad = VALID + MODELS.replace("api: responses", "api: grpc")
    with pytest.raises(ValidationError):
        load_runtime_config(write(tmp_path, bad))


REDIS = """
redis: {}
"""


def test_redis_env_required_when_section_present(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """配了 redis 段就必须有地址，缺了就在启动期报出是哪个变量。"""

    config = load_runtime_config(write(tmp_path, VALID + REDIS))
    _core(monkeypatch)
    with pytest.raises(ValidationError, match="REDIS_URL"):
        resolve_settings(config)


def test_redis_defaults_are_explicit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID + REDIS))
    _core(monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    redis = resolve_settings(config).redis

    assert redis is not None
    assert (redis.replay_window_seconds, redis.max_frames) == (3600, 100_000)


def test_no_redis_section_means_no_stream(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)

    assert resolve_settings(config).redis is None


MEDIA = """
media_generation:
  video:
    model: seedance
    user_name: iclip-agent
  image:
    user_name: iclip-agent
"""

MEDIA_ENV = {
    "VIDEO_SUBMIT_URL": "https://video.test/generate",
    "VIDEO_STATUS_BASE_URL": "https://video.test/tasks",
    "VIDEO_API_KEY": "vk",
    "IMAGE_TEXT_TO_IMAGE_URL": "https://image.test/text-to-image",
    "IMAGE_EDIT_URL": "https://image.test/image-edit",
    "OSS_BUCKET": "iclip",
    "OSS_ENDPOINT": "https://oss.test",
    "OSS_ACCESS_KEY_ID": "ak",
    "OSS_ACCESS_KEY_SECRET": "sk",
    "OSS_PUBLIC_URL_BASE": "https://cdn.test",
}


def _media_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _core(monkeypatch)
    for name, value in MEDIA_ENV.items():
        monkeypatch.setenv(name, value)


def test_media_generation_off_when_submit_url_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """开关在环境里（同 SSO）：地址为空就整项关闭，而不是半开着。"""

    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    monkeypatch.delenv("VIDEO_SUBMIT_URL")

    assert resolve_settings(config).media_generation is None


def test_media_generation_resolves_both_providers_and_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    media = resolve_settings(config).media_generation

    assert media is not None
    assert media.video_model == "seedance", "对方的模型名来自 YAML"
    assert media.image_text_to_image_url == "https://image.test/text-to-image"
    assert media.image_edit_url == "https://image.test/image-edit"
    assert media.object_store.public_url_base == "https://cdn.test"
    assert (media.poll_interval_seconds, media.job_timeout_seconds) == (5, 3600)


@pytest.mark.parametrize(
    "missing",
    ["VIDEO_STATUS_BASE_URL", "VIDEO_API_KEY", "IMAGE_EDIT_URL", "OSS_BUCKET"],
)
def test_media_generation_half_configured_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    """一旦开启，剩下的 env 就都是必需的——半开着比关着更糟。"""

    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    monkeypatch.delenv(missing)
    with pytest.raises(ValidationError, match=missing):
        resolve_settings(config)


SHOT_VIDEO = """
shot_video:
  understanding_model: seed-vision
  dev_attempts: 2
  pro_attempts: 1
"""

SHOT_VIDEO_ENV = {
    "VIDEO_UNDERSTANDING_URL": "https://vision.test/responses",
    "VIDEO_UNDERSTANDING_API_KEY": "ark",
}


def _shot_video_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _media_env(monkeypatch)
    for name, value in SHOT_VIDEO_ENV.items():
        monkeypatch.setenv(name, value)


def test_shot_video_off_when_understanding_url_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """开关在环境里：地址为空即整项关闭，哪怕 YAML 里留着这一段。

    真有 agent 声明要用它，装配期会在名字表那里报「引用了未登记的 capability」，
    所以这里安静地关掉不会变成一个查不出来的「它不干活」。
    """

    config = load_runtime_config(write(tmp_path, VALID + MEDIA + SHOT_VIDEO))
    _shot_video_env(monkeypatch)
    monkeypatch.delenv("VIDEO_UNDERSTANDING_URL")

    assert resolve_settings(config).shot_video is None


def test_shot_video_resolves_shape_and_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + SHOT_VIDEO))
    _shot_video_env(monkeypatch)
    shot = resolve_settings(config).shot_video

    assert shot is not None
    assert shot.understanding_url == "https://vision.test/responses"
    assert shot.understanding_model == "seed-vision", "对方的模型名来自 YAML"
    assert (shot.dev_attempts, shot.pro_attempts) == (2, 1)


def test_shot_video_half_configured_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + SHOT_VIDEO))
    _shot_video_env(monkeypatch)
    monkeypatch.delenv("VIDEO_UNDERSTANDING_API_KEY")
    with pytest.raises(ValidationError, match="VIDEO_UNDERSTANDING_API_KEY"):
        resolve_settings(config)


def test_shot_video_without_media_generation_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """出图与对象存储都走生成那一套，生成没开就是半开着——不许悄悄降级。"""

    config = load_runtime_config(write(tmp_path, VALID + MEDIA + SHOT_VIDEO))
    _shot_video_env(monkeypatch)
    monkeypatch.delenv("VIDEO_SUBMIT_URL")
    with pytest.raises(RuntimeError, match="VIDEO_SUBMIT_URL"):
        resolve_settings(config)


def test_shot_video_section_absent_means_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _shot_video_env(monkeypatch)

    assert resolve_settings(config).shot_video is None


PRODUCT_CATALOG_ENV = {
    "PRODUCT_CATALOG_DATABASE_URL": "postgresql+asyncpg://reader@catalog.test/catalog",
    "PRODUCT_IMAGE_BASE_URL": "https://bucket.test",
}


def _product_catalog_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _core(monkeypatch)
    for name, value in PRODUCT_CATALOG_ENV.items():
        monkeypatch.setenv(name, value)


def test_product_catalog_off_when_database_url_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """开关在环境里，而且这项能力没有 YAML 段——连接串为空就是整项关闭。"""

    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)

    assert resolve_settings(config).product_catalog is None


def test_product_catalog_resolves_both_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _product_catalog_env(monkeypatch)
    catalog = resolve_settings(config).product_catalog

    assert catalog is not None
    assert catalog.image_base_url == "https://bucket.test"


def test_product_catalog_half_configured_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """查得到款却给不出图片地址，是那种点进去才发现的半开着。"""

    config = load_runtime_config(write(tmp_path, VALID))
    _product_catalog_env(monkeypatch)
    monkeypatch.delenv("PRODUCT_IMAGE_BASE_URL")
    with pytest.raises(ValidationError, match="PRODUCT_IMAGE_BASE_URL"):
        resolve_settings(config)


def test_inspirations_off_when_database_url_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)

    assert resolve_settings(config).inspirations is None


def test_inspirations_resolves_connection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """它只有一个值：视频地址在行上就是完整的，不用再配前缀。"""

    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.setenv("INSPIRATION_DATABASE_URL", "postgresql+asyncpg://reader@vl.test/vl")
    inspirations = resolve_settings(config).inspirations

    assert inspirations is not None
    assert inspirations.database_url.endswith("/vl")
