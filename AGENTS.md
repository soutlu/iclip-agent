# AGENTS.md — 开发约定

> 仓库含 `server/` 后端、`web/` 前端、`contract/` 跨端合同。业务概念与不变量见 [docs/CONTEXT.md](docs/CONTEXT.md)；后端机制见 [docs/architecture.md](docs/architecture.md)；前端命令与边界见 [web/AGENTS.md](web/AGENTS.md)；文档地图见 [README.md](README.md)。

## 1. 命令入口

常规操作收拢在根目录 `Makefile`。

| 命令 | 作用 |
|------|------|
| `make setup` | 安装后端 `uv` 依赖与前端 `pnpm` 依赖 |
| `make dev` | 启动后端（需 `.env`，Postgres 与 Redis 可用） |
| `make up` | 启动 Postgres、Redis 容器、外部只读库隧道、建表、后端、前端；可重复执行，不清库 |
| `make check` | Lint、格式化、类型检查、架构依赖检查、合同对账、常规测试 |
| `make test` | 单元与集成测试（Testcontainers 临时 Postgres 与 Redis，不打真实 LLM） |
| `make test-external` | 需要真实外部凭证的测试，缺凭证时跳过 |
| `make db-upgrade` | Alembic 升级到最新（启动时不自动建表） |
| `make web-check` | 前端 `ci:check` |
| `make contract` | 导出后端 OpenAPI 到 `contract/openapi.json` |

### 设计系统

视觉规范与组件契约只有一份：根目录 [design-system.html](design-system.html)。它第一个 `<style>` 里 `:root`（浅色）与 `.dark`（深色）两块是契约；运行时 token 在 `web/src/app/globals.css` 与 `base.css`，`pnpm lint:design` 逐名逐值对账。规范变更先改 HTML，再改运行时。视觉验收截图放 `.artifacts/design-qa/`（不入库）。

### 两端分工与合同

- 后端定义对外合同：端点、字段、状态码以 [contract/openapi.json](contract/openapi.json) 为准；合同表达不了的约定写在 [contract/conventions.md](contract/conventions.md)。
- 前端只消费合同：`pnpm contract:generate` 按 openapi.json 生成类型与 zod，端点形状不手写。
- 改对外端点的顺序：改后端 → `make contract` → `pnpm contract:generate`。
- 术语与不变量只在 [docs/CONTEXT.md](docs/CONTEXT.md) 一份。
- 整套联调 `make up`；只联前端 `make dev` + `cd web && pnpm dev`；不连后端 `pnpm dev:mock`。

## 2. 禁止动作

1. 不从 Request Body 或 Query 读取 `userId`、`tenantId` 判断权限；身份只取 `request.state.principal`。
2. 不在 Worker 进程内存缓存跨步骤业务状态或 Agent 会话队列；Postgres 是唯一事实源。
3. 不跨模块 import 其他 Domain 的私有文件，只引用 `public.py` 暴露的接口；不用 `# type: ignore`。
4. API Key、Token、密码不写进代码或 YAML，只从环境变量读；CORS 允许源不设 `"*"`。
5. 测试只用一次性 Testcontainers 容器或临时 schema；不对运行中的业务库执行 `DROP` 等破坏性操作。
6. 后端改了对外端点必须导出合同；前端不照文档或印象手写端点 schema。

## 3. 机器管不到的两条

- 改了 SSO / PMS 接入：在本地完整走通一次真实登录回调。
- 新建表：把该模块的元数据加进迁移比对测试的 `_MODULE_METADATA` 名单；`agent_runtime` schema 下的表没有自动比对，迁移自行核对。

其余边界——分层依赖、类型、格式、测试目录归层、合同漂移、CI、合并方式与 tag——由 tach、pyright、ruff、架构单测、contract-check、GitHub Actions 与仓库规则集强制。

## 4. 分支、版本与合并规范

### 4.1 分支

| 分支 | 角色 | 什么能合进来 | 合并方式 |
|------|------|--------------|----------|
| `main` | 已交付的版本，每次合并打一个版本 tag | 发版 PR（`develop → main`）、热修 PR；都要开发者确认 | merge commit |
| `develop` | 当前开发线，仓库默认分支 | 任务分支的 PR，CI 全绿即合；热修回流 PR（`main → develop`） | squash；回流用 merge commit |
| 任务分支 | 一个任务，活在 worktree 里 | 直接 commit / push | — |

`main` 与 `develop` 不能直接 push，必需检查 `server` + `web`，禁 force push、禁删除；合并后任务分支自动删除。

### 4.2 日常开发：任务分支 → develop

开发一律在 worktree 里进行；主目录常驻 main，不切分支。

1. 开 worktree（Claude Code 会话可用 `EnterWorktree`，落点起点相同）：
   ```
   git fetch origin
   git worktree add .claude/worktrees/<任务名> -b <分支名> origin/develop
   ```
   起点固定 `origin/develop`。唯一例外：依赖某个未合 PR 的代码时从该 PR 的分支起，PR 描述写「依赖 #N，等它先合」。
2. commit 后 `git push -u origin HEAD`。
3. `make check`（动了前端再加 `make web-check`）无误后 `gh pr create --base develop`。目标误指 main 的日常 PR：`gh pr edit <n> --base develop`，不要合。
4. 挂上自动合并，CI 全绿即合，不必请示：`gh pr merge <n> --auto --squash`
5. 清理：`gh pr view <n> --json state` 为 `MERGED`，`git worktree list` 确认是自己的，再
   ```
   git fetch origin
   git worktree remove .claude/worktrees/<任务名>
   git branch -D <分支名>
   ```

### 4.3 发版：develop → main

1. 开发者确认发版并给出版本号后开 PR：
   ```
   gh pr create --base main --head develop --title "发版 vX.Y.Z" --body "<内容摘要>"
   ```
2. CI 全绿、开发者确认后：`gh pr merge <n> --merge`
3. 打 tag 并生成更新说明：
   ```
   gh release create vX.Y.Z --target main --title vX.Y.Z --generate-notes
   git fetch --tags
   ```

### 4.4 版本号

`vX.Y.Z`，每次合进 main 必打，号由开发者定。X：重构或老用法不再兼容；Y：加功能，老用法可用；Z：只修 bug。前段加一，后段归零。`v0.Y.Z` 为未正式交付阶段，大改只加 Y。

### 4.5 热修：修已交付版本的 bug

1. 从 main 开 worktree：
   ```
   git fetch origin
   git worktree add .claude/worktrees/hotfix-<名> -b hotfix-<名> origin/main
   ```
2. `make check` 无误后 `gh pr create --base main`；CI 全绿、开发者确认后 `gh pr merge <n> --merge`，按 4.3 第 3 步打 `Z+1`。
3. 回流 develop：
   ```
   gh pr create --base develop --head main --title "回流 vX.Y.Z 热修"
   gh pr merge <n> --auto --merge
   ```

**Agent 禁区**：目标为 `main` 的 PR 一律要开发者确认后才开、才合；不直接 push `main` 或 `develop`。其余合并不请示。
