# iclip-agent

Productor 视频创作产品的单仓主体：`server/`（FastAPI + PydanticAI 后端）+ `web/`（React SPA 前端）。

- 控制面（命令、红线、验证矩阵）：[AGENTS.md](AGENTS.md)
- 领域锚点：[docs/CONTEXT.md](docs/CONTEXT.md) · 架构：[docs/architecture.md](docs/architecture.md)

## 快速开始

```bash
make setup        # server: uv sync；web: pnpm install
cp .env.example .env   # 填入本机环境变量
make dev          # 后端 localhost:7788
make check        # 提交前必跑：lint + typecheck + tach + 默认门禁测试
```

当前状态：M0（地基）——身份双主体（cookie 会话 + API key）、SSO/PMS、RBAC、迁移基线、CI。agent 运行时（harness/capabilities）自 M1 起构建。
