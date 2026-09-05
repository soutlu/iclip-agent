# Productor — iclip-agent

Productor 的后端与 Web 前端。产品定位、业务术语和不变量见 [docs/CONTEXT.md](docs/CONTEXT.md)，开发先读 [AGENTS.md](AGENTS.md)。

## 项目结构

```text
.
├── server/
│   ├── src/iclip/      # FastAPI 宿主、业务域、Agent 内核与能力
│   ├── tests/          # 单元、集成与外部服务测试
│   ├── migrations/     # Alembic 迁移
│   ├── configs/        # 运行配置
│   └── agents/         # Agent 声明、spec、提示词与技能
├── web/                # Vite + React SPA
├── contract/           # 后端导出的 OpenAPI 与跨端约定
├── docs/               # 领域、架构、测试、工具规范与 ADR
├── design-system.html  # 全局视觉规范与 token
├── Makefile            # 根目录命令入口
└── AGENTS.md           # 开发约定
```

## 启动指南

### 1. 准备依赖

需要 Python 3.13、uv、Node.js ≥ 22.18、pnpm，以及可连接的 PostgreSQL。仓内默认 Agent 启用了镜头素材能力，PATH 中还需有 `ffmpeg` 和 `ffprobe`。依赖版本以 [server/pyproject.toml](server/pyproject.toml)、[web/package.json](web/package.json) 与各自 lockfile 为准。

```bash
make setup
```

### 2. 配置环境

在仓库根目录创建 `.env`。必需变量及各能力的启用条件见 [配置模型](server/src/iclip/config/models.py) 与 [后端装配说明](docs/architecture.md#2-配置与装配)；启动时会列出缺失的必需变量名。数据库地址必须指向开发库，密钥不入库。

[server/agents/agents.yaml](server/agents/agents.yaml) 声明启用的 Agent。默认 `storyboard` 需要镜头素材、媒体生成、视频理解与对象存储依赖；仅运行基础对话时，可在自己的配置中移除这条 Agent 声明及 [运行配置](server/configs/config.yaml) 的 `shot_video` 段，启动后在首页 Agent 菜单选择「通用助手」。

### 3. 迁移并启动

确认 PostgreSQL 可用后，在仓库根目录执行：

```bash
make db-upgrade
make dev
```

后端默认 `http://localhost:7788`，健康检查为 `/healthz`。另开终端启动前端：

```bash
cd web
pnpm dev
```

前端默认 `http://localhost:3013`；同源 `/api` 代理到后端。仅验证前端时，使用 `pnpm dev:mock`；前端启动参数见 [web/README.md](web/README.md)。

## 文档地图

| 文档 | 内容与更新时机 |
|---|---|
| [AGENTS.md](AGENTS.md) | 全仓操作与开发规则变化时更新 |
| [web/AGENTS.md](web/AGENTS.md) | 前端命令、边界、验证要求变化时更新 |
| [docs/CONTEXT.md](docs/CONTEXT.md) | 两端共用的领域术语、不变量和禁止逻辑变化时更新 |
| [docs/architecture.md](docs/architecture.md) | 后端分层、职责和装配机制变化时更新 |
| [contract/openapi.json](contract/openapi.json) | 后端端点变更后由 `make contract` 导出 |
| [contract/conventions.md](contract/conventions.md) | OpenAPI 无法表达的跨端约定变化时更新 |
| [design-system.html](design-system.html) | 全局视觉规则与 token 变化时更新 |
| [web/README.md](web/README.md) | 前端启动方式与目录变化时更新 |
| [web/docs/frontend-implementation.md](web/docs/frontend-implementation.md) | 前端实现与测试约定变化时更新 |
| [docs/test-design.md](docs/test-design.md) | 后端测试分层、边界和环境变化时更新 |
| [docs/tool-design.md](docs/tool-design.md) | Agent 工具面向模型的接口与文字规范变化时更新 |
| [docs/adr/](docs/adr/)、[web/docs/adr/](web/docs/adr/) | 记录架构决策与取舍；后继决策标明替代关系 |
