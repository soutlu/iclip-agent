"""热重载：模型表与 agent 层整体替换，坏配置与非热区段改动都不碰当前层。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path

import httpx
import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.agent_layer import CurrentAgentLayer
from iclip.app.bootstrap import build_app
from iclip.config import (
    AppSection,
    DbSection,
    ModelSection,
    OpsSection,
    ResolvedAgent,
    RuntimeConfig,
    SecuritySection,
    SsoSection,
)
from iclip.config.models import ConversationsSection
from iclip.domains.identity.middleware import PrincipalResolver
from iclip.domains.identity.models import Principal

MODEL_KEY_ENV = "TEST_MODEL_KEY"


@pytest.fixture
def base_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://iclip:iclip@localhost:5432/nowhere")
    monkeypatch.setenv("AUTH_SECRET", "s" * 32)
    monkeypatch.setenv(MODEL_KEY_ENV, "k")
    for name in ("SSO_BASE_URL", "OSS_BUCKET", "VIDEO_SUBMIT_URL", "VIDEO_UNDERSTANDING_URL"):
        monkeypatch.delenv(name, raising=False)


def model(context_window: int | None = None) -> ModelSection:
    """离线就能装配的模型声明：provider 与地址都不会在装配期发请求。"""

    return ModelSection(
        provider="openai",
        api_key_env=MODEL_KEY_ENV,
        base_url="https://llm.test/v1",
        context_window=context_window,
    )


def config(models: dict[str, ModelSection], *, cookie_name: str = "iclip_session") -> RuntimeConfig:
    return RuntimeConfig(
        app=AppSection(name="t"),
        db=DbSection(schema="iclip"),
        security=SecuritySection(session_cookie_name=cookie_name),
        sso=SsoSection(app_name="iclip"),
        ops=OpsSection(log_level="WARNING"),
        models=models,
        conversations=ConversationsSection(title_model=next(iter(models), None)),
    )


def agent(tmp_path: Path, agent_id: str, *, model: str, instructions: str = "") -> ResolvedAgent:
    spec_dir = tmp_path / agent_id
    spec_dir.mkdir(parents=True, exist_ok=True)
    spec = spec_dir / "agent.yaml"
    spec.write_text("", encoding="utf-8")
    instructions_path = spec_dir / "instructions.md"
    instructions_path.write_text(instructions, encoding="utf-8")
    return ResolvedAgent(
        agent_id=agent_id,
        spec=spec,
        instructions=instructions_path,
        model=model,
        skills=None,
        capabilities=(),
        subagents=(),
    )


class _Source:
    """可替换返回值的配置来源，模拟磁盘上的文件被改过。"""

    def __init__(self, config: RuntimeConfig, agents: Sequence[ResolvedAgent]) -> None:
        self.config = config
        self.agents = agents

    def __call__(self) -> tuple[RuntimeConfig, Sequence[ResolvedAgent]]:
        return self.config, self.agents


def build(tmp_path: Path) -> tuple[CurrentAgentLayer, _Source, httpx.AsyncClient]:
    initial = config({"m": model(context_window=1000)})
    source = _Source(initial, (agent(tmp_path, "storyboard", model="m"),))
    app = build_app(
        initial,
        agents=source.agents,
        engine=create_async_engine("postgresql+asyncpg://iclip:iclip@localhost:5432/nowhere"),
        reload_source=source,
    )
    layer: CurrentAgentLayer = app.state.agent_layer
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    return layer, source, client


def grant_permissions(monkeypatch: pytest.MonkeyPatch, *permissions: str) -> None:
    """身份解析使用替身，路由仍执行真实权限检查；无需连接账号数据库。"""

    principal = Principal(
        kind="user",
        user_id=uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="tester",
    )

    async def resolve(
        _self: PrincipalResolver, _headers: Mapping[str, str], _cookies: Mapping[str, str]
    ) -> Principal:
        return principal

    monkeypatch.setattr(PrincipalResolver, "resolve", resolve)


@pytest.mark.parametrize(
    ("permission", "status"), [(None, 401), ("agent:read", 403), ("agent:run", 200)]
)
async def test_agent_directory_requires_run_permission(
    base_env: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    permission: str | None,
    status: int,
) -> None:
    if permission is not None:
        grant_permissions(monkeypatch, permission)
    _, _, client = build(tmp_path)

    async with client:
        response = await client.get("/conversations/agents")

    assert response.status_code == status
    if status == 200:
        assert response.json() == {"items": ["storyboard"], "default": "storyboard"}


async def test_agent_directory_follows_reload_order_and_empty_registry(
    base_env: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    grant_permissions(monkeypatch, "agent:run")
    layer, source, client = build(tmp_path)
    async with client:
        before = await client.get("/conversations/agents")
        assert before.json() == {"items": ["storyboard"], "default": "storyboard"}

        source.agents = (
            agent(tmp_path, "exact_replica", model="m"),
            agent(tmp_path, "storyboard", model="m"),
        )
        layer.reload()
        changed = await client.get("/conversations/agents")
        assert changed.json() == {
            "items": ["exact_replica", "storyboard"],
            "default": "exact_replica",
        }

        source.agents = ()
        layer.reload()
        empty = await client.get("/conversations/agents")
        assert empty.json() == {"items": [], "default": None}


def test_reload_swaps_agents_and_reuses_unchanged_models(base_env: None, tmp_path: Path) -> None:
    layer, source, _ = build(tmp_path)
    before = layer.current
    source.config = config({"m": model(context_window=1000), "n": model(context_window=2000)})
    source.agents = (
        agent(tmp_path, "storyboard", model="n"),
        agent(tmp_path, "assistant", model="m"),
    )

    layer.reload()

    assert layer.error is None
    assert layer.generation == 2
    assert layer.current.registry.ids == ("storyboard", "assistant")
    assert layer.current.context_limits == {"storyboard": 2000, "assistant": 1000}
    # 声明没变的模型沿用旧实例，新增的才新建。
    assert layer.current.models["m"] is before.models["m"]
    assert "n" not in before.models


def test_reload_with_undeclared_model_keeps_the_old_layer(base_env: None, tmp_path: Path) -> None:
    layer, source, _ = build(tmp_path)
    before = layer.current
    source.agents = (agent(tmp_path, "storyboard", model="ghost"),)

    layer.reload()

    assert layer.current is before
    assert layer.generation == 1
    assert layer.needs_restart is False
    assert layer.error is not None and "ghost" in layer.error


def test_reload_refuses_changes_outside_the_hot_sections(base_env: None, tmp_path: Path) -> None:
    layer, source, _ = build(tmp_path)
    before = layer.current
    source.config = config({"m": model(context_window=1000)}, cookie_name="other_cookie")

    layer.reload()

    assert layer.current is before
    assert layer.needs_restart is True
    assert layer.error is not None and "security" in layer.error


def test_reload_without_a_source_is_reported(base_env: None, tmp_path: Path) -> None:
    initial = config({"m": model()})
    app = build_app(
        initial,
        agents=(agent(tmp_path, "storyboard", model="m"),),
        engine=create_async_engine("postgresql+asyncpg://iclip:iclip@localhost:5432/nowhere"),
    )
    layer: CurrentAgentLayer = app.state.agent_layer

    layer.reload()

    assert layer.generation == 1
    assert layer.error is not None


async def test_healthz_reports_reload_state(base_env: None, tmp_path: Path) -> None:
    layer, source, client = build(tmp_path)
    async with client:
        fresh = await client.get("/healthz")
        source.config = config({"m": model(context_window=1000)}, cookie_name="other_cookie")
        layer.reload()
        refused = await client.get("/healthz")

    assert fresh.json() == {
        "status": "ok",
        "config": {"generation": 1, "error": None, "needs_restart": False},
    }
    assert refused.status_code == 200
    body = refused.json()
    assert body["status"] == "ok"
    assert body["config"]["generation"] == 1
    assert body["config"]["needs_restart"] is True
    assert "security" in body["config"]["error"]


async def test_watching_a_directory_reloads_after_a_file_changes(tmp_path: Path) -> None:
    from iclip.app.agent_layer import watch_and_reload

    watched = tmp_path / "agents"
    watched.mkdir()
    (watched / "instructions.md").write_text("v1", encoding="utf-8")
    reloads = 0

    def reload() -> None:
        nonlocal reloads
        reloads += 1

    import asyncio

    stop = asyncio.Event()
    task = asyncio.create_task(watch_and_reload((watched,), reload, stop=stop, debounce_ms=100))
    # 监听线程起来要一点时间，写早了事件会丢；隔一会儿再写一次，直到看到重载。
    for round_ in range(20):
        (watched / "instructions.md").write_text(f"v{round_}", encoding="utf-8")
        await asyncio.sleep(0.5)
        if reloads:
            break
    stop.set()
    await task

    assert reloads >= 1
