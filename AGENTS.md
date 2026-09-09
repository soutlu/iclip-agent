# AGENTS.md — 开发约定

先读本文与 [docs/CONTEXT.md](docs/CONTEXT.md)。修改后端时查 [docs/architecture.md](docs/architecture.md)，修改前端时再读 [web/AGENTS.md](web/AGENTS.md)。按任务查阅专项文档，入口见 [README.md](README.md#文档地图)。

## 1. 命令与验证

命令在仓库根目录执行；前端专项命令见 [web/AGENTS.md](web/AGENTS.md)。

| 命令 | 用途 |
|---|---|
| `make setup` | 安装后端与前端依赖 |
| `make dev` | 启动后端；环境准备见 [README.md](README.md#启动指南) |
| `make db-upgrade` | 执行 Alembic 迁移；服务启动不自动建表 |
| `make check` | 后端 lint、格式、类型、依赖边界、常规测试，以及合同与文档对账 |
| `make web-check` | 前端 `ci:check`；构建与 e2e 另见前端验证规则 |
| `make test` | 后端单元与无真实 LLM 的集成测试 |
| `make test-external` | 使用外部服务凭证的测试；环境与跳过规则见 [测试规范](docs/test-design.md) |
| `make contract` | 从后端导出 OpenAPI |
| `make docs-check` | 核对 Markdown 相对链接与 make 目标 |
| `make hooks` | 安装本地 pre-commit / pre-push hooks |

`make up` 调用本机维护、不入库的 `scripts/dev-up.sh`；新检出的仓库使用 README 的启动步骤。

- 后端变更提交前通过 `make check`；前端变更另按 [web/AGENTS.md](web/AGENTS.md) 验证。
- 纯文档变更运行 `make docs-check`，修改 `web/` 下的 Markdown 另查格式；不为措辞新增业务测试。
- 修改 SSO / PMS 接入后，本地走通一次真实登录回调。
- 数据库测试只用一次性测试库或临时 schema；`TEST_DATABASE_URL` 不得指向业务库。迁移检查范围见 [测试规范](docs/test-design.md)。

## 2. 合同与实现边界

- 领域术语与不变量以 [docs/CONTEXT.md](docs/CONTEXT.md) 为准，两端共用。
- 对外端点、字段、状态码由后端定义，以 [contract/openapi.json](contract/openapi.json) 为准；它表达不了的约定写在 [contract/conventions.md](contract/conventions.md)。
- 修改端点的顺序：后端实现 → `make contract` → 在 `web/` 执行 `pnpm contract:generate`。前端消费生成类型与 zod，不手写端点 schema。
- 全局视觉与 token 以 [design-system.html](design-system.html) 为准。token 先改规范，再同步运行时 CSS，通过 `pnpm lint:design`；验收截图放 `.artifacts/design-qa/`。
- 不通过忽略类型错误、关闭 lint 或放宽检查配置消除失败；先修正实现。

日志使用 `structlog.stdlib.get_logger(__name__)`，事件为固定短句，变量用关键字参数；不拼接 f-string 或 `%s`。请求上下文由中间件绑定，业务只增加本层字段。第三方常态噪音在 [app/logging.py](server/src/iclip/app/logging.py) 的 `QUIET_LOGGERS` 调整。

```python
_logger.warning("生成任务提交失败", job_id=job.id, code=exc.code)
```

## 3. 分支与交付

### 日常开发

开发在独立 worktree 中进行；主目录常驻 `develop`，不在其中开发或切换分支。

1. 从最新 `origin/develop` 建任务分支：
   ```bash
   git fetch origin
   git worktree add .claude/worktrees/<任务名> -b <分支名> origin/develop
   ```
   依赖未合 PR 时可从该 PR 分支起步，PR 描述注明「依赖 #N，等它先合」。
2. 完成适用检查后 commit，在任务 worktree 中推送并创建 PR：
   ```bash
   git push -u origin HEAD
   gh pr create --base develop
   gh pr merge <n> --auto --squash
   ```
   `server` 与 `web` 检查通过后自动合并，无需再次确认。日常 PR 误指 `main` 时先用 `gh pr edit <n> --base develop` 修正。
3. 用 `gh pr view <n> --json state` 确认 `MERGED`，用 `git worktree list` 确认是自己的 worktree，且没有待保留的未提交修改，再回主目录清理：
   ```bash
   git pull --ff-only
   git worktree remove .claude/worktrees/<任务名>
   git branch -D <分支名>
   ```

### 发版与热修

`main` 是已交付版本，只接收发版和热修；**创建或合并目标为 `main` 的 PR 都必须先获开发者确认**。`main` 与 `develop` 均不直接 push、不强推、不删除。

| 操作 | 起点与目标 | 合并方式 |
|---|---|---|
| 发版 | `develop → main`，开发者给出版本号后创建 PR | CI 通过并确认后 `gh pr merge <n> --merge` |
| 热修 | 从 `origin/main` 建独立 worktree，PR 指向 `main` | 检查、确认后 merge commit |
| 热修回流 | `main → develop` | `gh pr merge <n> --auto --merge` |

每次合入 `main` 后创建版本 release：

```bash
gh release create vX.Y.Z --target main --title vX.Y.Z --generate-notes
git fetch --tags
```

版本号由开发者确定。X 用于重构或不兼容变更，Y 用于兼容的新功能，Z 用于修复；前段增加时后段归零。`v0.Y.Z` 阶段的大改增加 Y，热修增加 Z。

## 4. 文档维护

- 普通文档只写现行事实和可执行规则，不写过程、进度或历史解释；ADR 保留决策与取舍，被替代的决策标明后继。
- 一处事实只有一个权威来源，其余链接过去；文档归属见 [README.md](README.md#文档地图)。
- 不复述类型、配置、检查工具已完整表达的细节；保留职责、入口、工具无法判断的约束与操作步骤。
- 发现文档与实现不一致时，结合合同和已接受 ADR 判断；实现偏差不能自动变成新规范。
- 更新文档后核对命令、路径、链接，并运行 `make docs-check`。
