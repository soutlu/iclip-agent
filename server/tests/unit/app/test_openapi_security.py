"""合同 security 守卫：端点权限只在路由上声明，导出的每个受保护操作都带着它。"""

from __future__ import annotations

from typing import Any

import pytest
from scripts.dump_openapi import PLACEHOLDER_CONFIG_DIR, PLACEHOLDER_ENV

from iclip.app.bootstrap import build_app
from iclip.config import load_agent_declarations, load_runtime_config
from iclip.domains.identity.public import PERMISSIONS

SCHEMES = {"SessionCookie", "BearerToken"}
"""合同公开的两个 scheme 名；改名就是改合同。"""

PUBLIC = {
    ("get", "/healthz"),
    ("post", "/auth/login"),
    ("post", "/auth/register"),
    ("get", "/auth/sso/authorize"),
    ("get", "/auth/sso/callback"),
}
"""不要凭证的操作，恰好这几条。"""

HTTP_METHODS = {"get", "put", "post", "delete", "patch", "options", "head", "trace"}


@pytest.fixture(scope="module")
def document() -> dict[str, Any]:
    """与 ``make contract`` 同一份装配：占位环境与占位配置，全部可选模块打开，路由才齐。"""

    with pytest.MonkeyPatch.context() as patch:
        for name, value in PLACEHOLDER_ENV.items():
            patch.setenv(name, value)
        # unit 门禁的机器不装 ffmpeg；这里只取文档，不处理媒体。
        patch.setattr("iclip.app.bootstrap.ffmpeg_available", lambda: True)
        app = build_app(
            load_runtime_config(PLACEHOLDER_CONFIG_DIR / "config.yaml"),
            agents=load_agent_declarations(PLACEHOLDER_CONFIG_DIR / "agents.yaml"),
        )
        return app.openapi()


def operations(document: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    return {
        (method, path): operation
        for path, item in document["paths"].items()
        for method, operation in item.items()
        if method in HTTP_METHODS
    }


def test_every_operation_outside_the_public_list_declares_security(
    document: dict[str, Any],
) -> None:
    unguarded = {
        key for key, operation in operations(document).items() if not operation.get("security")
    }

    assert unguarded == PUBLIC


def test_security_only_names_the_two_contract_schemes(document: dict[str, Any]) -> None:
    assert set(document["components"]["securitySchemes"]) == SCHEMES
    for key, operation in operations(document).items():
        for requirement in operation.get("security", []):
            assert requirement and set(requirement) <= SCHEMES, (key, requirement)


def test_scopes_are_known_permissions(document: dict[str, Any]) -> None:
    for key, operation in operations(document).items():
        for requirement in operation.get("security", []):
            for scopes in requirement.values():
                assert set(scopes) <= set(PERMISSIONS), (key, scopes)


def test_logout_is_guarded_by_the_session_cookie_alone(document: dict[str, Any]) -> None:
    """logout 是 fastapi-users 的路由，靠换掉 cookie transport 的 scheme 才用上合同里的名字。"""

    assert operations(document)[("post", "/auth/logout")]["security"] == [{"SessionCookie": []}]
