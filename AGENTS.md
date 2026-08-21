# AGENTS.md — 开发指南

iclip-agent 是 Productor 视频创作产品的后端与合同主体：FastAPI 模块化单体，Postgres 是唯一事实源，Agent 引擎为 PydanticAI。本文面向在本仓库工作的 AI agent 与新成员，只讲怎么干活；事实细节看：
术语与不变量 → [docs/CONTEXT.md](docs/CONTEXT.md) · 架构 → [docs/architecture.md](docs/architecture.md) · 测试 → [docs/test-design.md](docs/test-design.md) · 决策 → [docs/adr/](docs/adr/) · 跨端合同 → [contract/conventions.md](contract/conventions.md) · 前端 → `web/AGENTS.md`

本仓不维护预排的里程碑或阶段计划：每一步做什么由用户决定。

## 项目地图

- `server/` — 后端主体（Python 3.13 + uv）。`src/iclip/` 下：`app/` 组合根与装配、`domains/` 业务模块、`harness/` Agent 运行内核、`capabilities/` 业务与内核之间的适配层、`platform/` 数据库等基础设施、`config/` 配置系统。
- `server/tests/` — 四层测试树：`unit` / `integration_no_llm` / `integration_llm` / `e2e_full`，公共设施在 `helpers/`。
- `server/migrations/` — Alembic 数据库迁移。
- `web/` — UI 参考稿，只读不改，何时对接由用户决定。
- `docs/`、`contract/` — 见文首的事实源清单。

## 常用命令

| 命令 | 作用 |
|------|------|
| `make setup` | server `uv sync` + web `pnpm install` |
| `make dev` | 本地 reload 启动（需 `.env`，变量名见 `server/configs/config.yaml` 的 `*_env` 字段） |
| `make lint` | `ruff check` |
| `make format` | `ruff format`（CI 用 `ruff format --check`） |
| `make typecheck` | `pyright`（strict） |
| `make test` | 默认测试：`pytest -m "unit or integration_no_llm"` |
| `make check` | lint + format 检查 + typecheck + 架构检查 + 默认测试，提交前必跑 |
| `make db-upgrade` | 数据库结构演进的唯一入口：`alembic upgrade head` |
| `make test-external` | 依赖真实外部服务的测试（缺凭证自动 skip） |
| `make web-check` | 前端检查：`pnpm ci:check` |
| `make hooks` | 安装本地 git hooks（commit 时快检查，非防线） |

## 本地运行

1. `cp .env.example .env`，填入真实值。
2. `make setup`。
3. 准备好本地 Postgres 后 `make db-upgrade`（服务启动不会自动建表）。
4. `make dev`，`GET /healthz` 返回 200 即正常；未登录访问 `GET /users/me` 应得 401。

## 开发流程

仓库是 GitHub 公开仓，main 有分支保护：CI 不绿合不进，合并后远端分支自动删除。

1. 每个任务开一条短命分支，改代码，push。
2. `gh pr create` 开 PR。
3. squash 合并（一个任务合成 main 上一个提交）：`gh pr merge <编号> --auto --squash` 等 CI 绿后自动合并，或在 PR 页面手动点。何时合并由用户决定，agent 不自行合并 PR。
4. 合并后 `git pull`，删掉本地分支。

## 约定

架构边界（哪层能 import 什么、框架只准出现在哪）不用背：tach + 架构测试机械强制，`make check` 红了会指出违反了哪条；设计意图见 [docs/architecture.md](docs/architecture.md)。下面只列工具拦不住、必须自觉遵守的事：

- 这是公开仓，密钥绝不进任何仓内文件。配置 YAML 只写 `*_env` 变量名，真实值只放环境变量。
- 身份只信 `request.state.principal`；请求体、查询串里的 userId / tenantId 一律不可信。
- API key 的权限就是签发时显式授予的那些，不随属主角色变化，也不做角色继承。
- 不移植、不参考其他项目的代码、测试和 prompt，一切以官方文档、官方源码加本仓设计为源。
- CORS 不配 `"*"`。
- 测试要空库就用测试容器或 scratch schema，不对运行库做破坏性操作。
- 依赖锁定精确版本，不手改 `uv.lock` 绕过检查。
- 新命令加进 Makefile，不散落在 README 或口头约定里。
- 文件命名约定没有工具把守，靠 code review。

## 需要人工执行的事

- **DB 迁移**：所有环境人工 `make db-upgrade`；生产升级前先 dry-run 并备份。
- **root 引导**：SSO 场景配置 `ICLIP_ROOT_EMAIL`；非 SSO 场景运行 `uv run python -m scripts.admin set-roles <username> root`。普通注册默认 viewer、SSO 首登默认 editor，均无法自提权。
- **SSO 链路改动的验收**：在真实 wangoon 环境人工走一遍 authorize → callback → cookie → `/users/me`。
- **依赖升级**：人工决策与审阅；release notes 含行为开关时逐条看过再合。

## 提交前检查

- server 改动：`make check` 必须全绿。
- 前端改动（一般不发生）：`make web-check`。
- 改了哪块行为，对应测试要跑过并给出输出；测试点登记在 [docs/test-design.md](docs/test-design.md)。
- CI（server + web 两个检查）全绿 PR 才能合并，这一条 GitHub 会强制。
