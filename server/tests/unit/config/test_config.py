"""配置加载与环境解析的失败即失败契约。"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from iclip.config import load_runtime_config, resolve_settings

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
