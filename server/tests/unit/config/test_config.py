"""配置加载与环境解析的失败即失败契约。"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from iclip.config import ResolvedSettings, RuntimeConfig, load_runtime_config, resolve_settings

VALID = """
app: {name: t}
db: {url_env: T_DB_URL, schema: iclip}
security: {secret_env: T_SECRET}
sso: {base_url_env: T_SSO, app_name: iclip, redirect_url_env: T_SSO_REDIRECT}
pms: {base_url_env: T_PMS}
ops: {log_level: INFO}
"""


def write(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "config.yaml"
    path.write_text(content, encoding="utf-8")
    return path


def test_valid_config_loads(tmp_path: Path) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    assert config.app.name == "t"
    assert config.db.db_schema == "iclip"


def test_unknown_key_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        load_runtime_config(write(tmp_path, VALID + "\nextra_section: {}\n"))


def test_cors_wildcard_rejected(tmp_path: Path) -> None:
    bad = VALID.replace(
        "security: {secret_env: T_SECRET}",
        'security: {secret_env: T_SECRET, cors_allow_origins: ["*"]}',
    )
    with pytest.raises(ValidationError):
        load_runtime_config(write(tmp_path, bad))


def test_missing_file_fails(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_runtime_config(tmp_path / "absent.yaml")


def test_resolve_requires_db_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    monkeypatch.delenv("T_DB_URL", raising=False)
    with pytest.raises(RuntimeError, match="T_DB_URL"):
        resolve_settings(config)


def test_resolve_rejects_non_asyncpg_url(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    monkeypatch.setenv("T_DB_URL", "postgresql://x")
    monkeypatch.setenv("T_SECRET", "s" * 32)
    with pytest.raises(RuntimeError, match="asyncpg"):
        resolve_settings(config)


def test_resolve_rejects_short_secret(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    monkeypatch.setenv("T_DB_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("T_SECRET", "short")
    with pytest.raises(RuntimeError, match="32"):
        resolve_settings(config)


def test_sso_off_when_env_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    monkeypatch.setenv("T_DB_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("T_SECRET", "s" * 32)
    monkeypatch.delenv("T_SSO", raising=False)
    assert resolve_settings(config).sso is None


def test_sso_on_requires_redirect(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    monkeypatch.setenv("T_DB_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("T_SECRET", "s" * 32)
    monkeypatch.setenv("T_SSO", "https://sso.test")
    monkeypatch.delenv("T_SSO_REDIRECT", raising=False)
    with pytest.raises(RuntimeError, match="T_SSO_REDIRECT"):
        resolve_settings(config)

    monkeypatch.setenv("T_SSO_REDIRECT", "https://app.test/auth/sso/landing")
    monkeypatch.setenv("T_PMS", "https://pms.test")
    resolved = resolve_settings(config)
    assert resolved.sso is not None
    assert resolved.sso.pms_base_url == "https://pms.test"


MODELS = """
models:
  qwen3.8-max:
    provider: alibaba
    api: responses
    api_key_env: T_QWEN_KEY
    base_url: https://dashscope.test/v1
"""


def resolve_with_base(config: RuntimeConfig, monkeypatch: pytest.MonkeyPatch) -> ResolvedSettings:
    monkeypatch.setenv("T_DB_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("T_SECRET", "s" * 32)
    return resolve_settings(config)


def test_no_models_section_means_no_models(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert resolve_with_base(load_runtime_config(write(tmp_path, VALID)), monkeypatch).models == ()


def test_model_key_requires_its_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MODELS))
    monkeypatch.delenv("T_QWEN_KEY", raising=False)
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
