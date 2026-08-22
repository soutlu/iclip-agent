"""Runtime Configuration：YAML 只存环境变量名（``*_env``），不存密钥值。

加载分两步：``load_runtime_config`` 解析 YAML 为 frozen 模型（extra=forbid），
``resolve_settings`` 在启动期读取环境变量并快速失败——运行必需项缺失即抛错，
可选能力（SSO / PMS）由对应 env 是否为空决定开关。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)

_MIN_SECRET_LENGTH = 32


class ConfigSection(BaseModel):
    """所有配置段的共同约束：frozen + 未知字段即拒。"""

    model_config = ConfigDict(frozen=True, extra="forbid")


class AppSection(ConfigSection):
    name: str


class DbSection(ConfigSection):
    url_env: str
    db_schema: str = Field("iclip", alias="schema")

    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    @field_validator("db_schema")
    @classmethod
    def _schema_is_safe(cls, value: str) -> str:
        if not value.isidentifier():
            raise ValueError("schema 必须是合法标识符")
        return value


class SecuritySection(ConfigSection):
    secret_env: str
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
    base_url_env: str
    app_name: str
    redirect_url_env: str
    root_email_env: str = "ICLIP_ROOT_EMAIL"


class PmsSection(ConfigSection):
    base_url_env: str


class OpsSection(ConfigSection):
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"


class RuntimeConfig(BaseSettings):
    model_config = SettingsConfigDict(frozen=True, extra="forbid")

    app: AppSection
    db: DbSection
    security: SecuritySection
    sso: SsoSection
    pms: PmsSection
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
        # 只吃 YAML（经 init kwargs 注入路径）与显式 init 值；
        # 环境变量不直接覆盖配置结构——env 只承载 *_env 指向的值。
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
class ResolvedSettings:
    """启动期从环境变量解析出的运行值；SSO 关闭时 ``sso is None``。"""

    app_name: str
    database_url: str
    db_schema: str
    security: ResolvedSecurity
    sso: ResolvedSso | None
    log_level: str


def _require_env(name: str, *, hint: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"缺少运行必需的环境变量 {name}（{hint}）")
    return value


def resolve_settings(config: RuntimeConfig) -> ResolvedSettings:
    """读取 ``*_env`` 指向的环境变量并快速失败。"""

    database_url = _require_env(config.db.url_env, hint="Postgres 连接串")
    if not database_url.startswith("postgresql+asyncpg://"):
        raise RuntimeError(f"{config.db.url_env} 必须是 postgresql+asyncpg:// 连接串")
    secret = _require_env(config.security.secret_env, hint="会话 JWT 签名密钥")
    if len(secret) < _MIN_SECRET_LENGTH:
        raise RuntimeError(f"{config.security.secret_env} 长度必须 ≥ {_MIN_SECRET_LENGTH} 字符")

    sso: ResolvedSso | None = None
    sso_base = os.environ.get(config.sso.base_url_env, "").strip()
    if sso_base:
        redirect = _require_env(config.sso.redirect_url_env, hint="SSO 前端落地路由完整 URL")
        pms_base = os.environ.get(config.pms.base_url_env, "").strip() or None
        root_email = os.environ.get(config.sso.root_email_env, "").strip() or None
        sso = ResolvedSso(
            base_url=sso_base,
            app_name=config.sso.app_name,
            redirect_url=redirect,
            pms_base_url=pms_base,
            root_email=root_email,
        )

    return ResolvedSettings(
        app_name=config.app.name,
        database_url=database_url,
        db_schema=config.db.db_schema,
        security=ResolvedSecurity(
            secret=secret,
            cookie_name=config.security.session_cookie_name,
            lifetime_seconds=config.security.session_lifetime_seconds,
            cookie_secure=config.security.cookie_secure,
            cors_allow_origins=config.security.cors_allow_origins,
        ),
        sso=sso,
        log_level=config.ops.log_level,
    )
