# AGENTS.md — iclip-agent 控制面

> 面向在本仓库工作的 AI agent 与新成员的项目记忆：命令、边界、验证矩阵、禁止动作、人类门禁。
> 本文只做控制面，不做说明书——细节一律指向事实源文档：
> 领域锚点（术语、上下文、不变量、禁止逻辑）→ [docs/CONTEXT.md](docs/CONTEXT.md) · 架构 → [docs/architecture.md](docs/architecture.md) · 测试设计 → [docs/test-design.md](docs/test-design.md) · 决策 → [docs/adr/](docs/adr/) · 跨端合同 → [contract/conventions.md](contract/conventions.md)

## 1. 项目速览

iclip-agent 是 Productor 视频创作产品的后端与合同主体：模块化单体 monorepo，`server/`（Python 3.13 + uv，FastAPI）+ `web/`（**UI 参考稿**，只读、不约束后端合同）。**Postgres 是唯一事实源**；认证双主体（登录用户 cookie + API 调用方 Bearer key）；Agent 引擎选定 PydanticAI，关在 harness 围栏内。Agent 走**声明式配置化**、运行事实**全部落库**（[ADR-0001](docs/adr/0001-architecture-foundations.md)）。

后端现有实现：identity 业务模块（双主体 + SSO/PMS + 统一权限模型 [ADR-0002](docs/adr/0002-unified-permission-model.md)）、配置系统、架构门禁、CI workflow；`harness/` 含官方 pydantic_ai_harness StepPersistence 协议的 PG 后端（`step_store_pg.py`）+ Alembic 0002 的 `agent_runtime` 表；`capabilities/` 为空包占位，围栏已生效。**本仓不维护预排的里程碑/阶段计划：每一步做什么由用户决定。**

## 2. 统一命令入口

后端命令统一走根目录 `Makefile`；前端命令走 `web/package.json` scripts（参考稿，只跑不改）。新增命令必须加进 Makefile，不散落在 README 或口头约定里。

**开发流程**（远端 `soutlu/iclip-agent`）：每个任务开短命分支 → push → 开 PR → CI（server + web）全绿 → 人工 squash-merge 回 main（一个任务一个 main 提交）→ 删分支。免费版私有仓无分支保护硬闸门（已决策不升级）：**合并是人类门禁**——合并前人工确认两个检查全绿，不合红 PR、不直推 main；本地 hooks 只做提速反馈。

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
| `make web-check` | 前端门禁：`pnpm ci:check`（format:check → lint → lint:design → typecheck） |
| `make hooks` | 安装本地 git hooks（pre-commit 框架） |

## 3. 边界（哪里能改什么）

三环分层由 `server/tach.toml` + `server/tests/unit/architecture/` 机械强制（违反即默认门禁红）：

- **依赖红线**：`harness/`（通用内核）不认识业务；`domains/`（业务模块）不认识 pydantic_ai；`capabilities/` 是唯一同时认识两者的适配环；`app/` 是唯一组合根（唯一可 import 一切的地方）。
- **框架围栏**：`pydantic_ai` 只准出现在 `harness/`、`capabilities/`；`pydantic_ai_harness` **仅 `harness/`**（能力包经再导出使用）；`fastapi` 只在 `app/`、`domains/*/api.py`、`identity/middleware.py`、`identity/accounts.py`（fastapi-users 装配）、`main.py`；`sqlalchemy` 只在 `platform/db`、`domains/*/infra_sql.py`、`app` 组合根、`harness/step_store_pg.py`（harness 环唯一 SQL 适配器）；`fastapi-users` 只在 `identity/`。
- **跨模块只准 import 对方 `public.py`**；模块内 `models.py` / `commands.py` 只许 stdlib + common；`service.py` 出站只经 repository Protocol 与他模块 public。
- 业务模块固定包含**六边形八件套**：`models / commands / repository / infra_sql / service / api / public / module`；协议或框架适配可增加职责明确的扩展文件，但不得替代或绕过八件套边界。
- **测试树只有四层**（unit / integration_no_llm / integration_llm / e2e_full）+ `helpers/`；marker 按目录自动注入；根 `tests/` 与未知层级的 `test_*.py` 被 collection contract 拒收。
- **`agent_runtime` schema 是官方 StepPersistence 存储形状的镜像**：零自定义列、零自定义约束，形状只随 `pydantic_ai_harness` 版本升级而变；本仓自己的业务表进 `iclip` schema。

## 4. Verification Matrix

改了哪个面，就交哪份证据；「证据」指可展示的输出，不是「我觉得没问题」。

| Surface | 验证命令 | 证据 |
|---------|----------|------|
| 全仓（任何 server 改动的底线） | `make check` | ruff / pyright 零输出；tach 零违规；默认门禁全部 PASS |
| 架构契约 | `make test`（含 `tests/unit/architecture/`）；快速单查 `uv run tach check` | 依赖图、框架围栏、public-only、无静默 fallback 断言通过 |
| 配置加载 | `cd server && uv run pytest tests/unit/config -q` | 非法配置（未知字段 / 缺 env）在加载或启动期报错并指向字段 |
| identity HTTP（auth / users / api-keys） | `cd server && uv run pytest tests/unit/domains/identity tests/integration_no_llm/identity -q` | HTTP 状态码 + camelCase payload；cookie 与 Bearer 双主体链路 PASS |
| API key 语义 | 同上 | root 签发→Bearer 调用→吊销 401；key 权限即显式授权集、不随属主角色变化；DB 无明文 token |
| SSO | 同上（协议客户端注入 fake）+ 人工真实环境验收（§6） | callback 建号 editor、PMS 失败显式终止、关闭时路由 404 |
| WS 握手 | 同上（principal WS 测试） | cookie / Bearer / Origin 校验各分支 PASS |
| DB 迁移 | 人工 `make db-upgrade`；契约测试 `cd server && uv run pytest tests/integration_no_llm/bootstrap -q` | `alembic_version` 到 head；表结构与聚合元数据零漂移 |
| 运行持久化（`agent_runtime` 表 / step store） | `cd server && uv run pytest tests/integration_no_llm/test_step_store_pg.py -q` | 官方协议一致性 + 真实 Agent 运行落库 + 消息历史往返 PASS |
| 服务启动 | `make dev` | 启动日志无 error；`GET /healthz` 200；未认证 `GET /users/me` 401 |
| web（只读参考稿，一般不改） | `cd web && pnpm ci:check` | 全项 PASS |

## 5. 禁止动作

- **密钥写进 `configs/config.yaml` 或任何仓内文件**——YAML 只存 `*_env` 变量名，值只在环境变量。
- 绕过 `public.py` 跨模块 import；不改 `tach.toml` 就新增模块间依赖。
- `pydantic_ai` 越出 harness+capabilities 围栏；`pydantic_ai_harness` 越出 harness。
- 信任客户端身份（body / query / `forwardedProps` 里的任何 userId、tenantId）——可信身份只来自宿主建立的唯一 `request.state.principal`。
- 把 API key 权限做成角色继承——key 有效权限就是显式授予集；签发只归 `api_keys:issue`（仅 root），签发时校验授予集 ⊆ 签发者当下权限。
- 给 `agent_runtime` 表加自定义列或约束——它是官方存储形状的镜像，本仓的字段进 `iclip` schema。
- 静默 `except` fallback（架构测试禁止）。
- 生产使用宽松版本区间；绕过门禁手改 `uv.lock` 合入引擎升级。
- 在 `tests/` 根或未知层级放 `test_*.py`；测试 helper 命名为 `test_*.py`。
- 修改 `web/`——它是只读 UI 参考稿（需求来源，不是合同事实源）；前端对接时点由用户决策。
- 移植、拷贝或参考其他项目的代码、测试、fixtures、prompt 资产——一切以**官方协议 / 官方文档 / 官方包源码** + 本仓设计为源（读官方包源码取存储形状是必需动作，见 §3）；`web/` 是仓内 UI 设计稿，不在此列。
- CORS 配 `"*"`。
- 对运行库做破坏性 provisioning；测试需要空库只准用 scratch schema / 测试容器。

## 6. 人类门禁

| 动作 | 门禁 |
|------|------|
| PR 合并 | 人工确认 server + web 检查全绿后 squash-merge；不合红 PR、不直推 main（免费版私有仓无分支保护，已决策不升级） |
| DB 迁移（所有环境） | 人工 `make db-upgrade`；生产升级前 dry-run + 备份；启动期不自动迁移 |
| root 引导 | SSO 场景配置 `ICLIP_ROOT_EMAIL`；非 SSO 场景人工 `uv run python -m scripts.admin set-roles <username> root`（密码注册默认 viewer、SSO 首登默认 editor，均无法自提权） |
| SSO 链路变更验收 | 人工在真实 wangoon 环境走 authorize → landing → callback → cookie → `/users/me` 带部门资料 |
| 依赖升级 | 引擎升级 PR 门禁全绿才可合，release notes 含行为开关时人工审阅；web 运行时依赖升级人工决策，升级后 `pnpm verify` 全绿再合入 |

## 7. 机械 Guardrails 现状

| Guardrail | 状态 | 位置 / 说明 |
|-----------|------|-------------|
| lint / format | ✅ ruff（lint + format 一体） | `server/pyproject.toml [tool.ruff]` |
| typecheck | ✅ pyright strict | `server/pyproject.toml [tool.pyright]` |
| 架构约束 | ✅ tach 依赖图 + `tests/unit/architecture/`（围栏、public-only、无静默 fallback） | 默认门禁内强制 |
| 测试树契约 | ✅ 四层 + 目录注入 marker + collection contract | `server/tests/conftest.py` 等 |
| 棘轮基线 | ✅ 为空（棘轮 = 历史违规的豁免清单，只许减少不许新增；当前没有任何豁免） | 架构测试内登记 |
| pre-commit / pre-push | ✅ pre-commit 框架（`make hooks` 安装；commit：server ruff + web lint-staged，push：仅 pyright 快检查）。完整门禁由 CI + 人类合并门禁把守，本地钩子是提速反馈不是防线。web 自带 husky 在 monorepo 根下不生效，由根级 hooks 接管 | `.pre-commit-config.yaml` |
| CI | ✅ GitHub Actions（`soutlu/iclip-agent`）server + web 双 job | `.github/workflows/ci.yml` |
| 分支保护 | ⚠️ 不可用（GitHub 免费版私有仓限制，已决策不升级）；「CI 绿才合并」为人类门禁（§6） | — |
| naming guard | ⚠️ 文件名约定未机械强制 | 靠 code review |

## 8. 文档地图

| 文档 | 内容 | 何时更新 |
|------|------|----------|
| [AGENTS.md](AGENTS.md)（本文） | 控制面：命令、边界、验证矩阵、禁止动作、人类门禁 | 命令 / 红线 / 门禁变化时 |
| [docs/CONTEXT.md](docs/CONTEXT.md) | 领域锚点：术语、上下文、不变量、禁止逻辑（产品域完整登记，含尚未实现的产品概念） | 领域语言或不变量变化时 |
| [docs/architecture.md](docs/architecture.md) | 架构：分层、装配、配置、模块、表结构、路由面 | 随实现同步 |
| [docs/test-design.md](docs/test-design.md) | 测试哲学、四层规范、测试点登记 | 测试策略或覆盖变化时 |
| [docs/adr/](docs/adr/) | 架构决策记录 | 难逆决策时新增 |
| [contract/conventions.md](contract/conventions.md) | 跨端合同约定 | 合同变化时（双端同步） |
| `web/AGENTS.md` | 前端自带控制面 | 前端命令 / 红线 / 门禁变化时 |
