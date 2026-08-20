# iclip-agent

Productor——AI 视频创作产品。用户在网页里与 AI agent 对话，配合项目画布组织和推进视频创作；后端负责身份认证、项目数据与 agent 运行时，前端提供聊天与画布界面。

## 仓库结构

- `server/` —— 后端服务（Python 3.13 / FastAPI；Agent 引擎规划采用 PydanticAI，尚未接入）
- `web/` —— 前端应用（React SPA：聊天 + 项目画布）
- `contract/` —— 前后端接口合同约定
- `docs/` —— 架构、领域、重写计划等文档

## 环境要求

- Python 3.13 + [uv](https://docs.astral.sh/uv/)
- Node ≥ 22.12 + pnpm
- Postgres

## 快速开始

```bash
make setup             # 安装前后端依赖
cp .env.example .env   # 填入本机环境变量
make db-upgrade        # 初始化 / 升级数据库表结构
make dev               # 启动后端，默认 http://localhost:7788
```

启动成功后 `GET /healthz` 返回 200。

前端开发服务器单独启动：

```bash
cd web && pnpm dev     # 默认 http://localhost:3013，/api 代理到后端
```

## 开发

后端改动提交前运行 `make check`；前端改动运行 `make web-check`，合入 / 发布前再执行 `cd web && pnpm verify` 完成构建检查。完整命令列表、代码边界与验证要求见 [AGENTS.md](AGENTS.md)。
