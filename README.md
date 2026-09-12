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

模型表、agent 与 skill 不进仓库：把一份 `server/configs/`（`config.yaml`）与 `server/agents/`（`agents.yaml`、各 agent 目录、`skills/`）放到本机对应位置，两个目录已在 .gitignore。`agents.yaml` 声明启用的 Agent。默认 `storyboard` 挂载 `workspace`、`video` 与 `shot_video`，需要视频理解、媒体生成与对象存储；仅运行基础对话时，可移除这条 Agent 声明及 `config.yaml` 的 `video`、`shot_video` 段，另声明一条不挂这些能力的 Agent。首页 Agent 菜单显示声明里的 `name`，没写就显示 ID。改这两个目录里的文件保存即生效，不用重启。

只需视频拆解与 prompt 交付时，可为 Agent 只挂载 `workspace` 和 `video`；启用条件见[能力装配](docs/architecture.md#2-配置与装配)。

### 3. 迁移并启动

确认 PostgreSQL 可用后，在仓库根目录执行。已有数据库升级前先备份。

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

## 部署

两个镜像：`iclip-server`（[server/Dockerfile](server/Dockerfile)）与 `iclip-web`（[web/Dockerfile](web/Dockerfile)，nginx 托管静态产物并把 `/api` 去前缀反代到后端，配置见 [web/nginx.conf](web/nginx.conf)）。推 `v*` 标签时 [release-images](.github/workflows/release-images.yml) 自动构建并推到 ACR，标签为版本号与 `latest`；手动触发只打分支名标签，用于发版前验证推送。

在仓库根目录构建本地镜像。前端构建需包含 `contract/` 中的共享样例，构建上下文由 [web/Dockerfile.dockerignore](web/Dockerfile.dockerignore) 限定为前端和合同文件。

```bash
docker build -t iclip-server:local server
docker build -f web/Dockerfile -t iclip-web:local .
```

单机部署使用 [deploy/compose.yaml](deploy/compose.yaml)：一次性 `alembic upgrade head` → 后端 → 前端。Postgres 使用服务器现有实例，本项目独占一个数据库，先以管理员建库建账号：

```sql
CREATE ROLE iclip LOGIN PASSWORD '<密码>';
CREATE DATABASE iclip OWNER iclip;
```

服务器上准备一个目录，放入 [deploy/compose.yaml](deploy/compose.yaml) 与 [deploy/env.example](deploy/env.example)，再把 `configs/`、`agents/` 两个目录放到同目录（后端以只读挂载读它们，镜像里没有这两份）：

```bash
docker login registry.cn-shenzhen.aliyuncs.com
cp env.example .env   # 按注释填写真实值，DATABASE_URL 指向上面建的库
docker compose pull && docker compose up -d
curl http://localhost/api/healthz
```

后端只跑 1 个 worker，实时订阅在进程内存中。首个管理员：SSO 场景在 `.env` 设置 `ROOT_EMAIL`，该邮箱首次登录即 root；密码注册场景执行 `docker compose run --rm server python -m scripts.admin set-roles <账号> root,editor`。升级改 `.env` 的 `IMAGE_TAG` 后重新 `docker compose pull && docker compose up -d`，迁移随启动执行，数据卷保留。

### 改配置

模型、agent、skill 与其参考资料只存在于服务器的 `configs/`、`agents/`，不进仓库、不随镜像发版。直接改文件保存：后端监听这两个目录，约 1.5 秒后完整装配一遍并整体替换，正在跑的运行不受影响；写错则拒绝并沿用旧配置，原因在 `docker compose logs server` 与 `/healthz` 的 `config` 段（[ADR-0019](docs/adr/0019-hot-reload-agent-layer.md)）。手动触发一次：`docker compose kill -s HUP server`。

要重启的只有两种情况：改了 `models` 与 agents 以外的配置段（`/healthz` 会标 `needs_restart`），或 `.env` 加了新变量（比如新模型用新的 key 变量）。两种都执行 `docker compose up -d`，`restart` 不重读 `.env`。

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
