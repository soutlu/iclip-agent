# AGENTS.md — iclip-agent 控制面

> 面向在本仓库工作的 AI agent 与新成员的项目记忆：命令、边界、验证矩阵、禁止动作、人类门禁。
> 本文只做控制面，不做说明书——细节一律指向事实源文档：
> 领域术语与不变量 → [docs/CONTEXT.md](docs/CONTEXT.md) · 架构 → [docs/architecture.md](docs/architecture.md) · 测试设计 → [docs/test-design.md](docs/test-design.md) · 决策 → [docs/adr/](docs/adr/) · 跨端合同 → [contract/conventions.md](contract/conventions.md)

## 1. 项目速览

iclip-agent 是 Productor 视频创作产品的重写主体：模块化单体 monorepo，`server/`（Python 3.13 + uv，FastAPI）+ `web/`（Producer 前端纯拷贝迁入，**冻结**，重构另立轨道）。Agent 引擎为 PydanticAI（M1 起接入）；**Postgres 是唯一事实源**；认证支持双主体（登录用户 cookie + API 调用方 Bearer key）。

当前状态：**M0 地基**。已交付 identity（双主体 + SSO）、配置系统、架构门禁、CI；`harness/`、`capabilities/` 为空包预留（M1/M2 填充），`sessions` 表与 AG-UI 面属 M1。

## 2. 统一命令入口

后端命令统一走根目录 `Makefile`；前端命令走 `web/package.json` scripts（冻结期只跑不改）。新增命令必须加进 Makefile，不散落在 README 或口头约定里。

| 命令 | 作用 |
|------|------|
| `make setup` | server `uv sync` + web `pnpm install` |
| `make dev` | 本地 reload 启动（需 `.env`，变量名见 `server/configs/config.yaml` 的 `*_env` 字段） |
| `make lint` | `ruff check` |
| `make format` | `ruff format`（CI 用 `ruff format --check`） |
| `make typecheck` | `pyright`（strict） |
| `make test` | 默认门禁：`pytest -m "unit or integration_no_llm"` |
| `make check` | ruff check + ruff format --check + pyright + tach check + 默认门禁，**提交前必跑** |
| `make db-upgrade` | 业务表结构唯一演进入口：`alembic upgrade head`（所有环境人工执行；启动期不建表） |
| `make test-external` | 外部门禁（真实外部依赖，缺凭证自动 skip） |
| `make web-check` | 前端门禁（format:check → lint → lint:design → lint:tests → typecheck → 单测） |

## 3. 边界（哪里能改什么）

三环分层由 `server/tach.toml` + `server/tests/unit/architecture/` 机械强制（违反即默认门禁红）：

- **依赖红线**：`harness/`（通用内核）不认识业务；`domains/`（业务模块）不认识 pydantic_ai；`capabilities/` 是唯一同时认识两者的适配环；`app/` 是唯一组合根（唯一可 import 一切的地方）。
- **框架围栏**：`pydantic_ai` / `ag_ui` 只准出现在 `harness/`、`capabilities/`；`pydantic_ai_harness` **仅 `harness/`**（能力包经再导出使用）；`fastapi` 只在 `app/`、`domains/*/api.py`、`identity/middleware.py`、`identity/accounts.py`（fastapi-users 装配）、`main.py`；`sqlalchemy` 只在 `platform/db`、`domains/*/infra_sql.py`、`app` 组合根；`fastapi-users` 只在 `identity/`。
- **跨模块只准 import 对方 `public.py`**；模块内 `models.py` / `commands.py` 只许 stdlib + common；`service.py` 出站只经 repository Protocol 与他模块 public。
- 业务模块遵循**六边形八件套**：`models / commands / repository / infra_sql / service / api / public / module`。
- **测试树只有四层**（unit / integration_no_llm / integration_llm / e2e_full）+ `helpers/`；marker 按目录自动注入；根 `tests/` 与未知层级的 `test_*.py` 被 collection contract 拒收。
- **Policy 执法归 harness**（M2 起生效的红线，现在就写死）：账本资格 / 授权 / 审计由 harness 在装配时包在全部能力合并后的工具面外侧，不进任何能力包。

## 4. Verification Matrix

改了哪个面，就交哪份证据；「证据」指可展示的输出，不是「我觉得没问题」。

| Surface | 验证命令 | 证据 |
|---------|----------|------|
| 全仓（任何 server 改动的底线） | `make check` | ruff / pyright 零输出；tach 零违规；默认门禁全部 PASS |
| 架构契约 | `make test`（含 `tests/unit/architecture/`）；快速单查 `uv run tach check` | 依赖图、框架围栏、public-only、无静默 fallback 断言通过 |
| 配置加载 | `cd server && uv run pytest tests/unit/config -q` | 非法配置（未知字段 / 缺 env）在加载或启动期报错并指向字段 |
| identity HTTP（auth / users / api-keys） | `cd server && uv run pytest tests/unit/domains/identity tests/integration_no_llm/identity -q` | HTTP 状态码 + camelCase payload；cookie 与 Bearer 双主体链路 PASS |
| API key 语义 | 同上 | 创建→Bearer 调用→吊销 401→属主降权 403；DB 无明文 token |
| SSO | 同上（协议客户端注入 fake）+ 人工真实环境验收（§6） | callback 建号 editor、PMS 失败显式终止、关闭时路由 404 |
| WS 握手 | 同上（principal WS 测试） | cookie / Bearer / Origin 校验各分支 PASS |
| DB 迁移 | 人工 `make db-upgrade`；契约测试 `cd server && uv run pytest tests/integration_no_llm/bootstrap -q` | `alembic_version` 到 head；表结构与聚合元数据零漂移 |
| 服务启动 | `make dev` | 启动日志无 error；`GET /healthz` 200；未认证 `GET /users/me` 401 |
| web（冻结期一般不改） | `cd web && pnpm ci:check` | 全项 PASS |

## 5. 禁止动作

- **密钥写进 `configs/config.yaml` 或任何仓内文件**——YAML 只存 `*_env` 变量名，值只在环境变量。
- 绕过 `public.py` 跨模块 import；不改 `tach.toml` 就新增模块间依赖。
- `pydantic_ai` / `ag_ui` 越出 harness+capabilities 围栏；`pydantic_ai_harness` 越出 harness。
- 信任客户端身份（body / query / `forwardedProps` 里的任何 userId、tenantId）——可信身份只来自宿主建立的唯一 `request.state.principal`。
- 把 API key 权限做成角色继承——key 权限必须显式授予且 ⊆ 属主当下权限，校验在创建与解析两处强制。
- 把 Policy 执法（账本资格 / 授权 / 审计）写进能力包——执法只在 harness 装配层。
- 静默 `except` fallback（架构测试禁止）。
- 生产使用宽松版本区间；绕过契约门禁手改 `uv.lock` 合入引擎升级。
- 在 `tests/` 根或未知层级放 `test_*.py`；测试 helper 命名为 `test_*.py`。
- 从新后端输出重新生成 golden fixtures（M1 起适用；fixtures 是冻结验收标准）。
- 冻结期修改 `web/` 业务代码（仅安全修复与 M3 切换清单例外，需人工确认）。
- CORS 配 `"*"`。
- 对运行库做破坏性 provisioning；测试需要空库只准用 scratch schema / 测试容器。

## 6. 人类门禁

| 动作 | 门禁 |
|------|------|
| DB 迁移（所有环境） | 人工 `make db-upgrade`；生产升级前 dry-run + 备份；启动期不自动迁移 |
| 第一个 admin 提权 | 人工 `uv run python -m scripts.admin set-role <username> admin`（密码注册默认 viewer、SSO 默认 editor，均无法自提权） |
| SSO 全链路验收 | 人工在真实 wangoon 环境走 authorize → landing → callback → cookie → `/users/me` 带部门资料 |
| 引擎升级 PR（Renovate） | 契约门禁全绿才可合；release notes 含行为开关时人工审阅 |
| web 运行时依赖升级 | 人工决策；升级后 `pnpm verify` 全绿再合入 |

## 7. 机械 Guardrails 现状

| Guardrail | 状态 | 位置 / 说明 |
|-----------|------|-------------|
| lint / format | ✅ ruff（lint + format 一体） | `server/pyproject.toml [tool.ruff]` |
| typecheck | ✅ pyright strict | `server/pyproject.toml [tool.pyright]` |
| 架构约束 | ✅ tach 依赖图 + `tests/unit/architecture/`（围栏、public-only、无静默 fallback） | 默认门禁内强制 |
| 测试树契约 | ✅ 四层 + 目录注入 marker + collection contract | `server/tests/conftest.py` 等 |
| 棘轮基线 | ✅ 为空（只降不升） | 架构测试内登记 |
| pre-commit / pre-push | ✅ server：ruff / pyright + 定向单测；web：husky 随迁 | `.pre-commit-config.yaml`、`web/.husky/` |
| CI | ✅ GitHub Actions：server job（make check + alembic head，PG service container）+ web job（pnpm ci:check） | `.github/workflows/ci.yml` |
| naming guard | ⚠️ 文件名约定未机械强制 | 靠 code review |

## 8. 文档地图

| 文档 | 内容 | 何时更新 |
|------|------|----------|
| [AGENTS.md](AGENTS.md)（本文） | 控制面 | 命令 / 红线 / 门禁变化时 |
| [docs/CONTEXT.md](docs/CONTEXT.md) | 领域锚点：术语、不变量、禁止逻辑（含未生效条目的里程碑标注） | 领域语言或不变量变化时 |
| [docs/architecture.md](docs/architecture.md) | 架构：分层、装配、配置、模块、表结构、路由面 | 随实现同步 |
| [docs/test-design.md](docs/test-design.md) | 测试哲学、四层规范、测试点登记 | 测试策略或覆盖变化时 |
| [docs/adr/](docs/adr/) | 架构决策记录 | 难逆决策时新增 |
| [contract/conventions.md](contract/conventions.md) | 跨端合同约定（M1 起含 golden fixtures v2） | 合同变化时（双端同步） |
| `web/AGENTS.md` | 前端自带控制面（随迁，冻结期照旧生效） | 冻结期不动 |
