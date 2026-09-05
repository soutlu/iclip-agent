# Productor - iclip-agent

`iclip-agent` 是 Productor（AI 视频创作产品）的后端与 Web 前端。后端基于 PydanticAI 运行 agent，管理「镜头 → 结构层级 → 视频」的生成流程，对话历史、项目快照与 agent 状态全部持久化在 PostgreSQL。

## 项目结构

```text
.
├── server/             # 后端 (Python 3.13, FastAPI)
│   ├── src/            # 业务逻辑 (按 Domain 和 Capability 组织)
│   ├── tests/          # 测试 (unit / integration_no_llm / integration_llm / e2e_full)
│   ├── migrations/     # Alembic 数据库迁移
│   ├── configs/        # 服务配置
│   ├── agents/         # Agent 装配声明、各 agent 的 spec 与提示词、skills/ 技能库
│   └── pyproject.toml  # 后端依赖 (uv)
├── web/                # 前端 (Vite + React 19 + pnpm)；命令与边界见 web/AGENTS.md
├── docs/               # 领域锚点、后端架构、测试与工具规范、ADR
├── contract/           # 跨端合同：openapi.json 由后端导出，前端据此生成类型与 zod
├── design-system.html  # 全局视觉规范与 token 定义
├── Makefile            # 全部环境装配与启动命令
└── AGENTS.md           # 开发约定：命令入口、两端分工、禁止动作、分支流程
```

## 启动指南

需要 [Python 3.13](https://www.python.org/)、[uv](https://docs.astral.sh/uv/)、[Node.js ≥ 22.18](https://nodejs.org/)（前端 `.npmrc` 开了 `engine-strict`）、与 PostgreSQL。

### 1. 安装依赖

```bash
make setup
```

### 2. 环境配置

在仓库根目录建 `.env`。变量清单以 `server/src/iclip/config/models.py` 里的 `*Env` 类为准；缺少必需变量时启动报出变量名。

- 仓内的 `storyboard` agent 挂了镜头素材能力，媒体生成与视频理解两组变量必须填齐；只跑对话可把 `server/agents/agents.yaml` 里 `storyboard` 那条声明去掉。
- 对象存储：`OSS_BUCKET` 留空即关闭，`/uploads/*` 与 `/assets/*` 不挂载；填了就把该组填齐。
- 媒体生成：`VIDEO_SUBMIT_URL` 留空即关闭，`/generations` 不挂载、后台不跑；开启时该组填齐，且对象存储必须开着。

### 3. 初始化数据库

```bash
make db-upgrade
```

### 4. 启动服务

后端：

```bash
make dev
```

默认 `http://localhost:7788`，`/healthz` 为健康检查。

前端（另一个终端）：

```bash
cd web && pnpm dev
```

前端把 `/api` 请求代理到后端 `7788` 端口。整套一起起用 `make up`。

命令与开发流程见 [AGENTS.md](AGENTS.md)。

## 文档地图

- [AGENTS.md](AGENTS.md)：开发约定——命令入口、两端分工与合同、禁止动作、分支与合并流程。
- [web/AGENTS.md](web/AGENTS.md)：前端的命令、分层边界与门禁；起步与目录见 [web/README.md](web/README.md)。
- [docs/CONTEXT.md](docs/CONTEXT.md)：领域锚点（两端共用）——术语、不变量、禁止逻辑。
- [contract/](contract/)：跨端合同。`openapi.json` 由后端导出；`conventions.md` 写合同表达不了的约定。
- [design-system.html](design-system.html)：全局视觉规范与 token 定义。
- [docs/architecture.md](docs/architecture.md)：后端架构——分层依赖规则与装配流程。
- [docs/adr/](docs/adr/)：架构决策记录。
- [docs/tool-design.md](docs/tool-design.md)：agent 工具模型面文本的写法与禁区。
- [docs/test-design.md](docs/test-design.md)：测试分层、编写规则与数据库测试环境。
