# AGENTS.md — iclip-agent 控制面

> 面向在本仓库工作的 AI agent 与新成员：命令、开发流程、边界、验证矩阵、禁止动作、人类门禁。
> 本文只做控制面，不做说明书，细节一律指向事实源文档：
> 领域锚点 → [docs/CONTEXT.md](docs/CONTEXT.md) · 架构 → [docs/architecture.md](docs/architecture.md) · 测试设计 → [docs/test-design.md](docs/test-design.md) · 决策 → [docs/adr/](docs/adr/) · 跨端合同 → [contract/conventions.md](contract/conventions.md)

## 1. 项目速览

iclip-agent 是 Productor 视频创作产品的后端与合同主体，模块化单体 monorepo：

- `server/`：Python 3.13 + uv + FastAPI，本仓的实现主体。
- `web/`：UI 参考稿。只读，不约束后端合同。
- 远端是 GitHub **公开仓** `soutlu/iclip-agent`：任何提交内容全世界可见，密钥红线（§6）没有例外。

核心事实：

- Postgres 是唯一事实源。
- 认证双主体：登录用户走 cookie，API 调用方走 Bearer key。统一权限模型见 [ADR-0002](docs/adr/0002-unified-permission-model.md)。
- Agent 引擎选定 PydanticAI，关在 harness 围栏内；Agent 走声明式配置化，运行事实全部落库。见 [ADR-0001](docs/adr/0001-architecture-foundations.md)。
- 已实现的模块与表结构以 [docs/architecture.md](docs/architecture.md) 为准，本文不重复登记。

本仓不维护预排的里程碑或阶段计划：每一步做什么由用户决定。

## 2. 统一命令入口

后端命令统一走根目录 `Makefile`；前端命令走 `web/package.json` scripts（只跑不改）。新增命令必须加进 Makefile，不散落在 README 或口头约定里。

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

## 3. 开发流程

main 受分支保护，以下规则由 GitHub 机械强制：

- 合并 PR 前，`server` 与 `web` 两个 CI 检查必须全绿；红 PR 无法合并。
- main 禁止 force push、禁止删除。
- PR 合并后，远端功能分支自动删除。

每个任务的流程：

1. 开短命分支，改代码，push。
2. `gh pr create` 开 PR。
3. squash 合并，一个任务合成 main 上一个提交。两种方式等价，由用户选择：
   - `gh pr merge <编号> --auto --squash`：CI 全绿后自动合并；
   - 在 PR 页面人工点合并。
4. 本地 `git pull` 同步，删除本地分支。

安全设置（已在仓库设置中生效）：

- 外部贡献者 fork 提的 PR，其 CI 需仓库所有者批准才会运行。
- CI 的 GITHUB_TOKEN 只读（ci.yml 顶层 `permissions: contents: read`）。
- 分支保护对管理员不强制：所有者保留直推 main 的逃生口，日常不使用。

本地 hooks（`make hooks` 安装）：commit 时跑 server ruff + web lint-staged，push 时跑 pyright 快检查。hooks 只做提速反馈，完整防线是 CI + 分支保护。

## 4. 边界（哪里能改什么）

三环分层由 `server/tach.toml` + `server/tests/unit/architecture/` 机械强制，违反即默认门禁红。

依赖方向：

- `harness/`（通用内核）不认识业务。
- `domains/`（业务模块）不认识 pydantic_ai。
- `capabilities/` 是唯一同时认识两者的适配环。
- `app/` 是唯一组合根，也是唯一可以 import 一切的地方。

框架围栏（框架只准出现在指定位置）：

- `pydantic_ai`：仅 `harness/`、`capabilities/`。
- `pydantic_ai_harness`：仅 `harness/`，能力包经再导出使用。
- `fastapi`：仅 `app/`、`domains/*/api.py`、`identity/middleware.py`、`identity/accounts.py`、`main.py`。
- `sqlalchemy`：仅 `platform/db`、`domains/*/infra_sql.py`、`app` 组合根、`harness/step_store_pg.py`。
- `fastapi-users`：仅 `identity/`。

模块结构：

- 跨模块只准 import 对方的 `public.py`。
- `models.py` / `commands.py` 只许 stdlib + common；`service.py` 出站只经 repository Protocol 与他模块 public。
- 业务模块固定八件套：`models / commands / repository / infra_sql / service / api / public / module`。可按职责增加扩展文件，不得替代或绕过八件套。

测试树：

- 只有四层：unit / integration_no_llm / integration_llm / e2e_full，另加 `helpers/`。
- marker 按目录自动注入；`tests/` 根或未知层级的 `test_*.py` 被 collection contract 拒收；测试 helper 不得命名为 `test_*.py`。

数据库：

- `agent_runtime` schema 是官方 pydantic_ai_harness StepPersistence 存储形状的镜像：零自定义列、零自定义约束，形状只随官方包版本升级而变。
- 本仓自己的业务表一律进 `iclip` schema。

补充：文件命名约定未机械强制，靠 code review 把守。架构豁免棘轮清单当前为空，只许减少、不许新增豁免。

## 5. Verification Matrix

改了哪个面，就交哪份证据。「证据」指可展示的输出，不是「我觉得没问题」。

| Surface | 验证命令 | 证据 |
|---------|----------|------|
| 全仓（任何 server 改动的底线） | `make check` | ruff / pyright 零输出；tach 零违规；默认门禁全部 PASS |
| 架构契约 | `make test`（含 `tests/unit/architecture/`）；快速单查 `uv run tach check` | 依赖图、框架围栏、public-only、无静默 fallback 断言通过 |
| 配置加载 | `cd server && uv run pytest tests/unit/config -q` | 非法配置（未知字段 / 缺 env）在加载或启动期报错并指向字段 |
| identity HTTP（auth / users / api-keys） | `cd server && uv run pytest tests/unit/domains/identity tests/integration_no_llm/identity -q` | HTTP 状态码 + camelCase payload；cookie 与 Bearer 双主体链路 PASS |
| API key 语义 | 同上 | root 签发→Bearer 调用→吊销 401；key 权限即显式授权集、不随属主角色变化；DB 无明文 token |
| SSO | 同上（协议客户端注入 fake）+ 人工真实环境验收（§7） | callback 建号 editor、PMS 失败显式终止、关闭时路由 404 |
| WS 握手 | 同上（principal WS 测试） | cookie / Bearer / Origin 校验各分支 PASS |
| DB 迁移 | 人工 `make db-upgrade`；契约测试 `cd server && uv run pytest tests/integration_no_llm/bootstrap -q` | `alembic_version` 到 head；表结构与聚合元数据零漂移 |
| 运行持久化（`agent_runtime` 表 / step store） | `cd server && uv run pytest tests/integration_no_llm/test_step_store_pg.py -q` | 官方协议一致性 + 真实 Agent 运行落库 + 消息历史往返 PASS |
| 服务启动 | `make dev` | 启动日志无 error；`GET /healthz` 200；未认证 `GET /users/me` 401 |
| web（只读参考稿，一般不改） | `cd web && pnpm ci:check` | 全项 PASS |

## 6. 禁止动作

§4 的边界规则由工具机械强制，此处不重复；以下是工具拦不住、必须自觉遵守的红线：

- 密钥写进 `configs/config.yaml` 或任何仓内文件。YAML 只存 `*_env` 变量名，值只在环境变量。
- 信任客户端身份（body / query / `forwardedProps` 里的任何 userId、tenantId）。可信身份只来自宿主建立的唯一 `request.state.principal`。
- 把 API key 权限做成角色继承。key 的有效权限就是显式授予集；签发只归 `api_keys:issue`（仅 root），签发时校验授予集 ⊆ 签发者当下权限。
- 静默 `except` fallback（架构测试同时在单测层拦截）。
- 生产使用宽松版本区间；绕过门禁手改 `uv.lock` 合入引擎升级。
- 修改 `web/`。它是只读 UI 参考稿（需求来源，不是合同事实源）；前端对接时点由用户决策。
- 移植、拷贝或参考其他项目的代码、测试、fixtures、prompt 资产。一切以官方协议 / 官方文档 / 官方包源码 + 本仓设计为源；`web/` 是仓内 UI 设计稿，不在此列。
- CORS 配 `"*"`。
- 对运行库做破坏性 provisioning。测试需要空库只准用 scratch schema / 测试容器。

## 7. 人类门禁

| 动作 | 门禁 |
|------|------|
| PR 合并 | CI 全绿才能合并已由分支保护强制；何时合并、是否先人工 review 由用户决定，agent 不自行合并 PR |
| DB 迁移（所有环境） | 人工 `make db-upgrade`；生产升级前 dry-run + 备份；启动期不自动迁移 |
| root 引导 | SSO 场景配置 `ICLIP_ROOT_EMAIL`；非 SSO 场景人工 `uv run python -m scripts.admin set-roles <username> root`（密码注册默认 viewer、SSO 首登默认 editor，均无法自提权） |
| SSO 链路变更验收 | 人工在真实 wangoon 环境走 authorize → landing → callback → cookie → `/users/me` 带部门资料 |
| 依赖升级 | 引擎升级 PR 门禁全绿才可合，release notes 含行为开关时人工审阅；web 运行时依赖升级人工决策，升级后 `pnpm verify` 全绿再合入 |

## 8. 文档地图

| 文档 | 内容 | 何时更新 |
|------|------|----------|
| [AGENTS.md](AGENTS.md)（本文） | 控制面：命令、流程、边界、验证矩阵、禁止动作、人类门禁 | 命令 / 流程 / 红线 / 门禁变化时 |
| [docs/CONTEXT.md](docs/CONTEXT.md) | 领域锚点：术语、上下文、不变量、禁止逻辑（产品域完整登记，含尚未实现的产品概念） | 领域语言或不变量变化时 |
| [docs/architecture.md](docs/architecture.md) | 架构：分层、装配、配置、模块、表结构、路由面 | 随实现同步 |
| [docs/test-design.md](docs/test-design.md) | 测试哲学、四层规范、测试点登记 | 测试策略或覆盖变化时 |
| [docs/adr/](docs/adr/) | 架构决策记录 | 难逆决策时新增 |
| [contract/conventions.md](contract/conventions.md) | 跨端合同约定 | 合同变化时（双端同步） |
| `web/AGENTS.md` | 前端自带控制面 | 前端命令 / 红线 / 门禁变化时 |
