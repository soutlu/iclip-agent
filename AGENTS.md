# AGENTS.md — 控制面与开发契约 (Control Plane & Development Contracts)

> 本文档是 iclip-agent 这个仓库的**控制面**：`server/` 后端 + `web/` 前端 + `contract/` 跨端合同放在一起管。
> 它的作用是作为项目记忆，明确：命令入口、两端分工、架构边界、验证矩阵、禁止动作以及机械护栏。
>
> 业务概念与不变量（两端共用）→ [docs/CONTEXT.md](docs/CONTEXT.md)；后端机制 → [docs/architecture.md](docs/architecture.md)；前端自己的命令、边界与门禁 → [web/AGENTS.md](web/AGENTS.md)。本文对前端只登记与后端交界的部分。

## 1. 统一命令入口 (Command Entrypoints)

所有的常规操作均已收拢到根目录的 `Makefile`。严禁发明新的隐式脚本，也绝不允许把环境约定口口相传。

| 命令 (Command) | 场景与作用 (Description) |
|----------------|--------------------------|
| `make setup` | **装配环境**：依次安装后端的 `uv` 依赖与前端的 `pnpm` 依赖。 |
| `make dev` | **本地启动**：启动后端服务（需前置配置 `.env`，并确保 Postgres 与 Redis 可用）。 |
| `make up` | **整套起来做真实测试**：容器化的 Postgres 与 Redis、外部只读库的隧道、建表、后端、前端一条命令拉齐，Ctrl-C 一起收。可反复执行，不会清库。 |
| `make check` | **提交前门禁**：一键执行 Lint、格式化、类型检查、架构依赖检查和常规测试。 |
| `make test` | **执行测试**：执行单元与集成测试（自动使用 Testcontainers 启动临时 Postgres 与 Redis，跳过真实 LLM）。 |
| `make db-upgrade`| **数据库演进**：将 PostgreSQL 的表结构通过 Alembic 升级到最新（系统启动时不会自动建表）。 |
| `make web-check` | **前端防线**：触发前端的 `ci:check`（代码格式、Lint、设计规范、死代码、契约漂移、类型检查与单测）。 |
| `make contract` | **导出跨端合同**：把后端当前的 OpenAPI 写到 `contract/openapi.json`。改了任何对外端点就跑一次，再去 `web` 跑 `pnpm contract:generate` 更新生成的类型与 zod。 |

### 设计系统

前端的视觉规范与组件契约有唯一事实源：仓库根目录的 [design-system.html](design-system.html)，浏览器打开即是全文。

- 它的第一个 `<style>` 里 `:root`（浅色）与 `.dark`（深色）两块是契约本身；运行时只消费 `web/src/app/globals.css` 与 `base.css` 里的同名 token，程序不加载、不解析这个 HTML。
- 规范变更两边一起改：先改 HTML，再镜像到运行时；`pnpm lint:design` 逐名逐值对账，对不上就红。
- 视觉验收的截图写进 `.artifacts/design-qa/`（已忽略，不入库）。

### 两端分工与合同

- **后端定义产品行为与对外合同。** 端点、字段、状态码以 `make contract` 导出的 [contract/openapi.json](contract/openapi.json) 为准；合同表达不了的（路由代理、双主体认证、命名、错误信封）写在 [contract/conventions.md](contract/conventions.md)。
- **前端只消费合同。** `pnpm contract:generate` 按 openapi.json 生成类型与 zod，端点形状不手写。改对外端点的顺序：改后端 → `make contract` → `pnpm contract:generate` → 两边门禁各拦一个方向（`make check` 的 contract-check 比合同与后端路由，`pnpm ci:check` 的 contract:check 比生成物与合同）。
- **领域语言只有一份。** 术语与不变量写在 [docs/CONTEXT.md](docs/CONTEXT.md)，前端不另起一套；前端文档只写实现层的边界与门禁。
- 起整套做真实联调用 `make up`；只做前端联调用 `make dev` + `cd web && pnpm dev`；不连后端的页面原型与 e2e 用 `pnpm dev:mock`（浏览器 MSW 扮演后端）。

## 2. 边界与禁止动作 (Anti-patterns)

为了维护系统的确定性与安全性，以下行为在编写代码时被**严格禁止**（它们是被刻意设计掉的，绝不要以“临时方案”名义引入）：

1. ⛔️ **身份越权推断**：绝不允许从 Request Body 或 Query 参数中读取 `userId` 或 `tenantId` 来判断权限。唯一可信身份只能从 HTTP 中间件解析后的 `request.state.principal` 获取。
2. ⛔️ **状态驻留内存**：系统以 PostgreSQL 为全局唯一事实源。禁止在 Worker 进程内存中缓存跨步骤的业务状态或 Agent 会话队列（否则进程崩溃即丢失状态）。
3. ⛔️ **绕过防线强行引用**：禁止跨模块 import 其他 Domain 的内部私有文件（只能引用 `public.py` 中暴露的接口）。禁止用 `# type: ignore` 强行屏蔽 Pyright 的严格类型报错。
4. ⛔️ **硬编码密钥与 CORS 漏洞**：禁止将任何 API Key、Token 或敏感密码写入代码或 YAML 配置文件，它们必须从环境变量中读取。禁止将 CORS 的允许源设置为 `"*"`。
5. ⛔️ **破坏性测试**：测试中如果需要持久化数据库状态，必须使用一次性的 Testcontainers 容器或临时 Scratch Schema，严禁对本地正在运行的业务库执行 `DROP` 等破坏性动作。
6. ⛔️ **合同旁路**：后端改了对外端点不导出合同；前端照文档或印象手写端点 schema。合同只有 `contract/openapi.json` 一份，两边门禁都拿它比。

## 3. 验证矩阵 (Verification Matrix)

每个代码面的修改，都必须绑定对应的验证动作。修改了哪里，就必须出具相应的通过证据，绝不能仅凭“我觉得没问题”就发起合并。

| 修改面 (Surface) | 验证命令 / 门禁 | 预期证据 (Evidence) |
|------------------|----------------|---------------------|
| **常规逻辑 / 日常提交** | `make check` | 代码规范、Tach 架构检查必须 0 报错；测试全绿通过。 |
| **架构分层 / 新增模块** | `make check` (Tach 环节) | 控制台未报告“依赖方向违规”（例如下层 Domain 绝不能反向依赖上层）。 |
| **agent 运行 / 事件流** | `make test` | `T-STREAM-*` 全绿；其中断开语义那条会真起一个 uvicorn（替身传输测不出「读一半就断」）。 |
| **数据库模型变更** | `make db-upgrade` + `make test` | Alembic `upgrade head` 无异常；`T-MIG-01` 通过。注意它比对的是 `iclip` schema 下**全部**的表与 ORM 定义，所以新建表的模块必须把自己的元数据加进那条测试的名单，否则连自己那张表都在无人看守之列；`agent_runtime` 下的表则完全没有自动比对，改了要自己确认迁移已同步写好。 |
| **权限与鉴权逻辑** | `make test` (拦截鉴权) | 身份与权限测试集（`T-RBAC-01`, `T-KEY-*`, `T-AUTH-*`）全部绿灯。 |
| **接入第三方 API (如 SSO/PMS)**| `make test` + 人工验收 | 打替身客户端的 SSO/PMS 用例（在 `integration_no_llm` 层，由 `make test` 执行）全绿；且需在本地环境完整走通一次真实的登录回调链路并输出正常日志。 |
| **对外端点变更** | `make contract` + `pnpm contract:generate` | `contract/openapi.json` 已更新（`make check` 里的 contract-check 会拦住忘记导出的情况）；前端生成物同步更新，`pnpm contract:check` 通过。 |
| **前端相关** | `make web-check` | 前端的格式、Lint、设计规范、死代码、契约、类型检查与单测全绿。它不含构建，CI 会另外跑一次 `pnpm build`，所以本地过了仍可能被 CI 的构建步骤拦下。 |

## 4. 机械护栏 (Mechanical Guardrails)

为防止破窗效应，保障系统不被腐化，以下规则不由人工 Review 保证，而是由机器强制把守：

| Guardrail | 工具 / 状态 | 说明 |
|-----------|------------|------|
| **类型检查** | ✅ Pyright (Strict) | 类型不匹配一律拒绝。例外：第三方库没导出完整类型而产生的「类型不明」，这几项检查在 `server/pyproject.toml` 里是关掉的，这类漏网不会被拦住。 |
| **规范与格式** | ✅ Ruff | 替换了传统的 Flake8 + Black 组合，强制执行一致的 Python 现代语法规范。 |
| **架构隔离** | ✅ Tach (`tach check`) | 保护三环架构不被击穿：`harness/` 不许依赖业务模块，业务模块不许依赖 Agent 引擎，只有组合根 `app/` 能引用一切。外部存储的客户端逐文件登记于框架围栏（名单见 `docs/architecture.md` 落点表）；新增落点须同步登记，未登记即拒。 |
| **测试门禁** | ✅ Pytest Marker + 架构单测 | 测试用例按所在目录自动归到 `unit` / `integration_no_llm` 等层；文件放错位置由 `T-COLL-01` 这条单测报错点出来（不是在收集阶段被拒收）。 |
| **跨端合同** | ✅ contract-check（后端）+ contract:check（前端） | 合同与后端当前路由一致；前端生成物与合同逐字节一致。任一方向漂移即红。 |
| **前端护栏** | ✅ 见 [web/AGENTS.md](web/AGENTS.md) §7 | boundaries 分层、design-guard、knip 死代码、命名与导出锁、tsc 严格开关、Vitest 单测、Playwright e2e（CI 单独一步）。 |
| **CI 拦截** | ✅ GitHub Actions | PR 和主干推送时，服务端与前端的 CI 流水线必须双端全绿，否则强制阻断代码合并。 |

## 5. 开发、合并与清理规范

本仓库的主干 (main) 受到分支保护，严禁直接 Push。未通过全绿 CI 检查的代码无法合入，合并后远端特征分支会自动删除。

**开发一律在 worktree 里进行，不在主目录切分支。** 主目录常驻 main，谁都不去动它；每个任务在 `.claude/worktrees/<任务名>` 下开一个独立工作副本，自带分支。这样多个任务（以及多个并行的 Agent 会话）各改各的文件，互不覆盖，也不会因为谁切了一下分支而让别人的工作区突然变样。

1. **开 worktree**：`git worktree add .claude/worktrees/<任务名> -b <分支名> origin/main`（Claude Code 会话用 `EnterWorktree` 工具，落点相同）。从 `origin/main` 起，不从当前 HEAD 起——除非这次改动确实依赖某条还没合的分支，那种情况要在 PR 里写明它叠在谁上面。
2. **在 worktree 里开发**：完成本地 Commit 后 `git push -u origin HEAD`。
3. **本地检查与发 PR**：确保在该 worktree 里执行 `make check`（动了前端再加 `make web-check`）无误后，使用 `gh pr create` 发起合并请求。
4. **合并与清理 (必须有人类授权)**：
   - 自动运行的 Agent **在获得人类开发者的明确许可后**，可以且应当代为执行合并指令：`gh pr merge --auto --squash`。
   - PR 成功合入后，Agent 应负责清理：回到主目录执行 `git pull` 更新 main，再 `git worktree remove .claude/worktrees/<任务名>` 与 `git branch -D <分支名>`。清理前先 `git worktree list` 确认没删到别人正在用的那个。
   - 🚨 **安全底线**：严禁 AI Agent 在未获得用户明确同意的情况下，自作主张合入 PR。

## 附：文档地图 (Documentation Map)

- **[README.md](README.md)**：项目起步、快速入门指南与整体目录结构说明。
- **[docs/CONTEXT.md](docs/CONTEXT.md)**：【领域锚点，两端共用】所有名词定义、生命周期和最高不可变逻辑（开发必读）。
- **[docs/architecture.md](docs/architecture.md)**：【后端架构地图】模块的划分逻辑和装配流程。
- **[contract/](contract/)**：【跨端合同】`openapi.json`（后端导出，端点/字段/状态码的唯一事实源）与 `conventions.md`（合同表达不了的约定）。
- **[web/AGENTS.md](web/AGENTS.md)**：【前端控制面】前端的命令、分层边界、验证矩阵、禁止动作与门禁；起步与目录见 [web/README.md](web/README.md)。
- **[design-system.html](design-system.html)**：【前端视觉契约】颜色、排版、组件与状态的唯一规范，运行时 token 与它对账。
- **[docs/adr/](docs/adr/)**：【架构决策记录】系统演进中的核心技术方案选择及其背后的权衡思考。
- **[docs/tool-design.md](docs/tool-design.md)**：【工具编写规范】agent 工具模型面文本（docstring、指引、错误消息）怎么写。
- **[docs/test-design.md](docs/test-design.md)**：【测试设计】怎么写出符合规范的自动化用例、测试分几层、数据库测试环境规则。
- **[docs/test-registry.md](docs/test-registry.md)**：【测试点登记表】每个测试点断言什么行为、防的是哪类风险。
