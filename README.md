# Productor - iclip-agent

`iclip-agent` 是 Productor（AI 视频创作产品）的核心后端系统与 Web 前端工程集合。

它作为视频创作中枢与 AI 代理（基于 PydanticAI）的运行容器，负责调度大模型对话、管理“镜头 -> 结构层级 -> 视频”的生成逻辑，并连接底层 PostgreSQL 数据库以实现所有对话历史、项目快照及代理状态的持久化与崩溃恢复。

## 项目结构

本项目采用前后端在一个仓库统一管理的结构，主要目录说明如下：

```text
.
├── server/             # 后端服务代码 (Python 3.13, FastAPI)
│   ├── src/            # 核心业务逻辑 (按 Domain 和 Capability 组织)
│   ├── tests/          # 测试用例 (分为 unit 与 integration)
│   ├── migrations/     # Alembic 数据库迁移脚本
│   ├── configs/        # 服务配置文件
│   ├── agents/         # Agent 装配声明、各 agent 的 spec/提示词，以及 skills/ 技能库
│   └── pyproject.toml  # 后端依赖配置 (uv)
├── web/                # 前端 (Vite + React 19 + pnpm)；自己的控制面在 web/AGENTS.md
├── docs/               # 领域锚点（两端共用）、后端架构、测试与工具规范、ADR
├── contract/           # 跨端合同：openapi.json 由后端导出，前端据此生成类型与 zod
├── design-system.html  # 前端视觉规范与组件契约的唯一事实源（浏览器打开即看）
├── Makefile            # 【全局命令收口】所有的环境装配与启动命令
└── AGENTS.md           # 全仓控制面：命令入口、两端分工、验证矩阵、开发流程
```

## 启动指南

本地开发环境需要预先安装 [Python 3.13](https://www.python.org/)、[uv](https://docs.astral.sh/uv/)、[Node.js ≥ 22.18](https://nodejs.org/)（前端 `.npmrc` 开了 `engine-strict`，版本不够 `pnpm install` 直接失败）、PostgreSQL 数据库，以及 Redis（承载 agent 运行的事件流，断线重连要靠它）。

所有的常规操作均统一在 `Makefile` 中管理。

### 1. 安装依赖

依次安装后端 `uv` 依赖与前端 `pnpm` 依赖：

```bash
make setup
```

### 2. 环境配置

复制环境变量示例文件，并根据本地真实的配置（特别是 `DATABASE_URL` 数据库连接串）进行修改：

```bash
cp .env.example .env
```

仓内的 `storyboard` agent 挂了镜头素材能力，因此媒体生成与视频理解那两组变量必须填齐，否则启动即报错。只想跑对话不碰镜头素材的话，把 `server/agents/agents.yaml` 里 `storyboard` 那条声明去掉。

> 公开对象存储也是一项可选能力，有自己的开关：`OSS_BUCKET` 留空即整项关闭，`/uploads/*` 与 `/assets/*` 不挂载（素材传不进来）。填了就得把那一组填齐。
>
> 媒体生成（视频/图片）是可选能力：`VIDEO_SUBMIT_URL` 留空即整项关闭，`/generations` 不挂载、后台也不跑。要开就得把那一组变量填齐，**并且对象存储也得开着**（图片结果要转存成自己的公开对象，否则库里存的是几天后就失效的签名地址）——只填一半会在启动时报错，因为半开着的能力比关着更难查。

### 3. 初始化数据库

将 PostgreSQL 的表结构通过 Alembic 升级到最新：

```bash
make db-upgrade
```

### 4. 启动服务

**启动后端：**

```bash
make dev
```
> 默认运行在 `http://localhost:7788`。
> 可通过浏览器访问 `http://localhost:7788/healthz` 检查后端服务是否启动成功。

**启动前端：**

在另一个终端窗口中启动前端开发服务器：

```bash
cd web && pnpm dev
```
> 前端会自动将发往 `/api` 的请求代理到后端的 `7788` 端口。

## 开发与门禁

为了保障复杂的架构不被腐化，本项目配置了严格的自动化检查防线。**完整的防线由 CI 在 PR 上把守**；本地的 git 钩子只跑其中最快的几项（提交时跑 Ruff 与前端 lint-staged，推送时跑 Pyright），所以发 PR 之前请自己手动跑一遍下面的命令：

- **`make check`**：后端门禁。一键执行代码规范 (Ruff)、类型检查 (Pyright Strict)、架构隔离检查 (Tach) 与常规测试。
- **`make test`**：跑单元与集成测试（会启用临时的 Testcontainers 数据库，跳过真实 LLM）。
- **`make web-check`**：前端门禁。格式、Lint、设计规范、死代码、契约漂移、类型检查与单测（不含构建与 e2e，CI 会另外跑 `pnpm build` 与 `pnpm test:e2e`）。
- **`make contract`**：后端改了对外端点之后导出合同到 `contract/openapi.json`，再到 `web/` 跑 `pnpm contract:generate`；两边的门禁各拦一个方向的漂移。

## 核心文档导航 (必读)

为了对齐概念、遵循架构边界规范，新加入项目的开发者必须阅读以下核心控制面文件，不要凭借历史经验“猜”逻辑：

- **[AGENTS.md](AGENTS.md)**: **全仓控制面与开发契约**。命令入口、两端分工与合同流程、后端边界与禁止动作、验证矩阵、worktree 开发流程。所有自动化 Agent 与人类开发者在编写代码时都必须遵守此契约。
- **[web/AGENTS.md](web/AGENTS.md)**: **前端控制面**。前端的命令、分层边界、门禁与禁止动作；前端起步与目录结构见 [web/README.md](web/README.md)。
- **[docs/CONTEXT.md](docs/CONTEXT.md)**: **领域锚点（两端共用）**。产品核心名词的定义、系统生命周期以及**绝对不能违背的底层逻辑与不变量**（例如数据库读写原则、权限隔离逻辑等）。
- **[contract/](contract/)**: **跨端合同**。`openapi.json` 由后端导出，是端点、字段、状态码的唯一事实源；`conventions.md` 写合同表达不了的约定（路由代理、双主体认证、命名、错误信封）。
- **[design-system.html](design-system.html)**: **前端视觉规范与组件契约**，浏览器打开即看；运行时 token 与它逐名逐值对账。
- **[docs/architecture.md](docs/architecture.md)**: **架构设计地图**。展示了后端的三环分层（组合根 `app/` 之下，通用内核 `harness/`、业务能力包 `capabilities/`、业务模块 `domains/` 三者互不越界，共同建立在 `platform/` 与 `common/` 之上）与模块装配逻辑。
- **[docs/adr/](docs/adr/)**: **架构决策记录 (Architecture Decision Records)**。记录了系统演进过程中的重要技术选择、架构方案定型及其背后的上下文与权衡考虑（如 ADR-0001 的三环分层与引擎地基、ADR-0002 的统一权限抽象模型）。
- **[docs/tool-design.md](docs/tool-design.md)**: **工具编写规范**。约定 agent 工具面向模型的文本的写法与禁区。
- **[docs/test-design.md](docs/test-design.md)**: **测试设计规范**。阐述了现有的测点设计思路与如何编写符合规范的测试用例。
- **[docs/test-registry.md](docs/test-registry.md)**: **测试点登记表**。逐条列出每个测试点断言什么行为、防的是哪类风险。