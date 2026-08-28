# AGENTS.md — 控制面与开发契约 (Control Plane & Development Contracts)

> 本文档是 iclip-agent 后端与系统全局的**控制面**。
> 它的作用是作为项目记忆，明确：命令入口、架构边界、验证矩阵、禁止动作以及机械护栏。
>
> 任何业务概念（是什么）、系统不变量（必须成立的逻辑），请前往 👉 [docs/CONTEXT.md](docs/CONTEXT.md)。

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
| `make web-check` | **前端防线**：触发前端的 `ci:check`（包含代码格式、Lint、类型推断与设计规范的检查）。 |

### 设计系统

前端的视觉规范与组件契约有唯一事实源：仓库根目录的 [design-system.html](design-system.html)，浏览器打开即是全文。

- 它的第一个 `<style>` 里 `:root`（浅色）与 `.dark`（深色）两块是契约本身；运行时只消费 `web/src/app/globals.css` 与 `base.css` 里的同名 token，程序不加载、不解析这个 HTML。
- 规范变更两边一起改：先改 HTML，再镜像到运行时；`pnpm lint:design` 逐名逐值对账，对不上就红。
- 视觉验收的截图写进 `.artifacts/design-qa/`（已忽略，不入库）。

## 2. 边界与禁止动作 (Anti-patterns)

为了维护系统的确定性与安全性，以下行为在编写代码时被**严格禁止**（它们是被刻意设计掉的，绝不要以“临时方案”名义引入）：

1. ⛔️ **身份越权推断**：绝不允许从 Request Body 或 Query 参数中读取 `userId` 或 `tenantId` 来判断权限。唯一可信身份只能从 HTTP 中间件解析后的 `request.state.principal` 获取。
2. ⛔️ **状态驻留内存**：系统以 PostgreSQL 为全局唯一事实源。禁止在 Worker 进程内存中缓存跨步骤的业务状态或 Agent 会话队列（否则进程崩溃即丢失状态）。
3. ⛔️ **绕过防线强行引用**：禁止跨模块 import 其他 Domain 的内部私有文件（只能引用 `public.py` 中暴露的接口）。禁止用 `# type: ignore` 强行屏蔽 Pyright 的严格类型报错。
4. ⛔️ **硬编码密钥与 CORS 漏洞**：禁止将任何 API Key、Token 或敏感密码写入代码或 YAML 配置文件，它们必须从环境变量中读取。禁止将 CORS 的允许源设置为 `"*"`。
5. ⛔️ **破坏性测试**：测试中如果需要持久化数据库状态，必须使用一次性的 Testcontainers 容器或临时 Scratch Schema，严禁对本地正在运行的业务库执行 `DROP` 等破坏性动作。

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
| **前端相关** | `make web-check` | 前端的格式、Lint、设计规范与类型检查全绿。它不含构建，CI 会另外跑一次 `pnpm build`，所以本地过了仍可能被 CI 的构建步骤拦下。 |
| **发版 / 热修到 main** | CI + `make up` + 人工验收 | 发版 PR 的 CI 全绿；`make up` 把整套（库、隧道、后端、前端）拉起来，在页面上把一次完整的 agent 运行走通；真实登录回调链路走通。三项结果写进 PR 描述。热修只做与改动相关的那部分。 |

## 4. 机械护栏 (Mechanical Guardrails)

为防止破窗效应，保障系统不被腐化，以下规则不由人工 Review 保证，而是由机器强制把守：

| Guardrail | 工具 / 状态 | 说明 |
|-----------|------------|------|
| **类型检查** | ✅ Pyright (Strict) | 类型不匹配一律拒绝。例外：第三方库没导出完整类型而产生的「类型不明」，这几项检查在 `server/pyproject.toml` 里是关掉的，这类漏网不会被拦住。 |
| **规范与格式** | ✅ Ruff | 替换了传统的 Flake8 + Black 组合，强制执行一致的 Python 现代语法规范。 |
| **架构隔离** | ✅ Tach (`tach check`) | 保护三环架构不被击穿：`harness/` 不许依赖业务模块，业务模块不许依赖 Agent 引擎，只有组合根 `app/` 能引用一切。外部存储的客户端逐文件登记于框架围栏（名单见 `docs/architecture.md` 落点表）；新增落点须同步登记，未登记即拒。 |
| **测试门禁** | ✅ Pytest Marker + 架构单测 | 测试用例按所在目录自动归到 `unit` / `integration_no_llm` 等层；文件放错位置由 `T-COLL-01` 这条单测报错点出来（不是在收集阶段被拒收）。 |
| **CI 拦截** | ✅ GitHub Actions | PR 以及推到 main / develop 时，服务端与前端的 CI 流水线必须双端全绿，否则强制阻断代码合并。 |
| **合并方式与版本 tag** | ✅ GitHub 规则集 | main 只接受 merge commit，develop 只接受 squash 或 merge commit，选错在合并按钮上就被禁掉；`v*` 的 tag 禁删禁改。仓库管理员可绕过，是唯一的逃生口。 |

## 5. 分支、版本与合并规范

### 5.1 分支拓扑

| 分支 | 角色 | 什么能合进来 | 合并方式 |
|------|------|--------------|----------|
| `main` | 已交付的版本，每次合并都对应一个版本 tag | 发版 PR（`develop → main`）和热修 PR，都要开发者确认 | merge commit |
| `develop` | 当前开发线 | 任务分支的 PR，CI 全绿即合；热修后 `main → develop` 的回流 PR | squash；回流用 merge commit |
| 任务分支 | 一个任务的改动，活在 worktree 里 | 直接 commit / push | — |

`main` 与 `develop` 受同样的分支保护：不能直接 push，必需检查 `server` + `web` 全绿，禁 force push、禁删除；表里的合并方式由规则集强制（见 §4）；合并后任务分支在远端自动删除。保护不要求 PR 先跟上最新的 develop 才能合——那会让并行的 PR 每次都要手动更新再等一轮 CI；代价是两个各自全绿的 PR 合到一起可能坏，靠推到 develop 时再跑一次 CI 兜住，红了下一个 PR 修。仓库默认分支是 `develop`：`gh pr create` 不写目标就打到它，`EnterWorktree` 自建的 worktree 也从它起；目标为 main 的 PR 要显式写 `--base main`。

### 5.2 日常开发：任务分支 → develop

开发一律在 worktree 里进行，不在主目录切分支。主目录常驻 main，谁都不去动它；每个任务在 `.claude/worktrees/<任务名>` 下开一个独立工作副本，自带分支，多个任务和多个并行的 Agent 会话各改各的文件，互不覆盖。

1. **开 worktree**
   ```
   git fetch origin
   git worktree add .claude/worktrees/<任务名> -b <分支名> origin/develop
   ```
   先 fetch 是因为 `origin/develop` 只是本地对远端的记忆，不刷新就会从旧位置起。Claude Code 会话用 `EnterWorktree` 工具，落点相同、起点相同（默认分支 develop）。
   起点固定是 `origin/develop`，不是当前 HEAD。唯一例外：这个任务要用到另一个还没合进 develop 的 PR 里的代码，那就从那个 PR 的分支起，并在 PR 描述里写「依赖 #N，等它先合」——因为这个 PR 会连带显示 #N 的改动，看的人要知道哪些不是本任务的，以及合并顺序。
2. **开发并推送**：在 worktree 里 commit，`git push -u origin HEAD`。
3. **本地检查、发 PR**：`make check` 无误后
   ```
   gh pr create --base develop
   ```
   日常 PR 如果建错了、合并目标指向了 main，不要合它，用 `gh pr edit <n> --base develop` 把目标改回 develop（改动本身不受影响）。
4. **合并**：发完 PR 就挂上自动合并，CI 全绿会自动合入，不必再问
   ```
   gh pr merge <n> --auto --squash
   ```
5. **清理**：先确认 PR 已合并（`gh pr view <n> --json state` 显示 `MERGED`——squash 之后 git 认不出分支已合，下面用的是强删），再 `git worktree list` 确认要删的是自己那个，然后回主目录
   ```
   git fetch origin
   git worktree remove .claude/worktrees/<任务名>
   git branch -D <分支名>
   ```

### 5.3 发版：develop → main（开发者确认后）

1. 开发者说要交付，才开这个 PR（不给标题会进入交互问答，Agent 会卡住）：
   ```
   gh pr create --base main --head develop --title "发版 vX.Y.Z" --body "<验收结果>"
   ```
2. 合入前按 §3「发版 / 热修到 main」那行验收，结果写进 PR 描述。验收针对的是 develop 当时的提交：发版 PR 开着期间 develop 不合新 PR，动了就重验。
3. 用 merge commit 合入，不用 squash——squash 会让 main 上出现一个 develop 没有的提交，下一次发版时凡是发版后又改过的文件都会冲突（规则集已把 main 上的 squash 禁掉）：
   ```
   gh pr merge <n> --merge
   ```
4. 打版本 tag 并生成更新说明（版本号由开发者在确认发版时给出，规则见 5.4）：
   ```
   gh release create vX.Y.Z --target main --title vX.Y.Z --generate-notes
   git fetch --tags
   ```

### 5.4 版本号

格式 `vX.Y.Z`，每次合进 main 都必须打一个，号由开发者定。

| 改哪一段 | 什么时候 | 例 |
|----------|----------|----|
| X（主版本） | 重构、老用法不再兼容 | `v1.4.2 → v2.0.0` |
| Y（次版本） | 加功能，老用法都还能用 | `v1.4.2 → v1.5.0` |
| Z（补丁） | 只修 bug，不加功能 | `v1.4.2 → v1.4.3` |

前面一段加一，后面的段归零。`v0.Y.Z` 表示尚未正式交付、随时可能大改，这阶段大改只加 Y。当前 main 是 `v0.1.0`（前端重写前的最后一版）。

### 5.5 热修：修已交付版本的 bug

develop 上已经堆着下一个版本，不能整条合进 main，所以修复从 main 起、先进 main、再回流 develop。

1. **从 main 开 worktree**（不是 develop）：
   ```
   git worktree add .claude/worktrees/hotfix-<名> -b hotfix-<名> origin/main
   ```
2. **发 PR 到 main**：`make check` 无误后 `gh pr create --base main`。按 §3「发版 / 热修到 main」那行做与改动相关的验收，CI 全绿 + 开发者确认后 `gh pr merge <n> --merge`，再按 5.3 第 4 步打 `Z+1` 的 tag。
3. **回流 develop**：让开发线也带上这个修复，否则下个版本会把 bug 带回来。
   ```
   gh pr create --base develop --head main --title "回流 vX.Y.Z 热修"
   gh pr merge <n> --auto --merge
   ```
   回流用 merge commit，不用 squash，理由同 5.3 第 3 步。

🚨 **Agent 禁区**：目标为 `main` 的 PR（发版、热修）一律要开发者确认后才开、才合；不直接 push `main` 或 `develop`。除此之外的合并动作不需要再向人请示。

## 附：文档地图 (Documentation Map)

- **[README.md](README.md)**：项目起步、快速入门指南与整体目录结构说明。
- **[docs/CONTEXT.md](docs/CONTEXT.md)**：【领域锚点】所有名词定义、生命周期和最高不可变逻辑（开发必读）。
- **[docs/architecture.md](docs/architecture.md)**：【架构地图】模块的划分逻辑和装配流程。
- **[docs/adr/](docs/adr/)**：【架构决策记录】系统演进中的核心技术方案选择及其背后的权衡思考。
- **[docs/tool-design.md](docs/tool-design.md)**：【工具编写规范】agent 工具模型面文本（docstring、指引、错误消息）怎么写。
- **[docs/test-design.md](docs/test-design.md)**：【测试设计】怎么写出符合规范的自动化用例、测试分几层、数据库测试环境规则。
- **[docs/test-registry.md](docs/test-registry.md)**：【测试点登记表】每个测试点断言什么行为、防的是哪类风险。
