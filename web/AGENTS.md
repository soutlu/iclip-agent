# AGENTS.md — Cue 前端

> 领域术语与不变量（两端共用）→ [../docs/CONTEXT.md](../docs/CONTEXT.md) · 全仓命令与合同流程 → [../AGENTS.md](../AGENTS.md) · 视觉规范 → [../design-system.html](../design-system.html)（在仓库根目录）。其余文档见 §7。

## 1. 项目速览

AI 视频创作前端。Vite 8 + React 19 纯 SPA：TanStack Router 文件式路由 + TanStack Query 数据层，浏览器经同源 `/api` 访问后端。**无 BFF、前端不持有 token**（决策与硬约束见 [docs/adr/0001](docs/adr/0001-vite-spa-same-origin-no-bff.md)）。Node ≥ 22.18 + pnpm；TypeScript strict。

## 2. 统一命令入口（pnpm scripts）

| 命令                                | 作用                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm install`                      | 安装依赖（本地 git hooks 由根仓 `make hooks` 安装）                                           |
| `pnpm dev`                          | 开发服务器（默认 0.0.0.0:3013；全部 `/api` 请求代理到真实后端）                               |
| `pnpm dev:mock`                     | 浏览器 MSW 原型环境（默认 0.0.0.0:3014；不连接真实后端，未处理 `/api` 请求显式报错）          |
| `pnpm lint` / `pnpm lint:fix`       | ESLint（flat config，boundaries 架构守卫）                                                    |
| `pnpm lint:design`                  | 设计系统检查：规范 ↔ 运行时 token 对账（含自测）+ design-guard 硬编码扫描                     |
| `pnpm lint:dead`                    | knip：没人引用的文件、导出、依赖即红                                                          |
| `pnpm test`                         | Vitest 单测（jsdom + Testing Library + MSW）                                                  |
| `pnpm test:e2e`                     | Playwright 端到端：起 `dev:mock`，浏览器 MSW 扮演后端                                         |
| `pnpm contract:generate`            | 按 `contract/openapi.json` 重新生成 `src/shared/api/generated`（类型 + zod）                  |
| `pnpm contract:check`               | 契约对账：入库生成物必须与合同逐字节一致                                                      |
| `pnpm typecheck`                    | `tsc -b` 全量类型检查                                                                         |
| `pnpm build`                        | `tsc -b && vite build`                                                                        |
| `pnpm serve`                        | 本地验证生产构建（build + vite preview）                                                      |
| `pnpm format` / `pnpm format:check` | Prettier                                                                                      |
| `pnpm ci:check`                     | 提交前检查：format:check → lint → lint:design → lint:dead → contract:check → typecheck → test |
| `pnpm verify`                       | 合入 / 发布前完整检查：ci:check 全项 + build                                                  |

## 3. 边界（哪里能改什么）

分层方向、跨 feature 禁令、图标与 radix 的唯一入口、文件名与具名导出、死代码与硬编码色值，这些边界由 eslint（boundaries、no-restricted-imports / -syntax、check-file）、knip、design-guard 与 tsc 强制。以下是机器判不出来的部分：

- 依赖单向向下：`main.tsx → app/`（壳与 router 装配）`→ routes/`（路由装配层）`→ features/<name>`（业务模块）`→ shared/`（共用层）。两个 feature 要共用东西只有两条路：下沉 `shared/`，或者在 routes / app 层组装。
- `src/routes/**` 只做 `createFileRoute` 装配、`beforeLoad` 守卫与 search params 校验，不写业务逻辑；`src/routeTree.gen.ts` 自动生成，不手改。
- 每页都要有的外壳（侧栏、用户菜单、登录弹窗）放 `src/routes/_shell.tsx`（侧栏与登录信号拆在同目录 `-app-sidebar.tsx`、`-login-prompt.tsx`，`-` 前缀不进路由树），不塞进任何 feature。
- 后端 REST 请求一律经 `apiFetch(path, schema)`（`@/shared/api/client`，响应在边界处过 zod）；裸 fetch 仅限两类非 REST 场景：OSS 预签名直传 PUT、外链素材下载。
- 构建期代码（vite 代理、dev profile）放 `vite/`，归 `tsconfig.node.json`；`src/` 不带 Node 类型。
- 没有登录页：未登录能进首页，需要登录的动作调 `useLoginPrompt()` 弹登录框；整页都要求登录的页面（需求单页、会话页）用 `beforeLoad` + `ensureSessionUser()` 守卫，未登录 redirect 回 `/`（[ADR-0002](docs/adr/0002-login-dialog-no-login-page.md)）。任意接口 401 / 403 都先强刷 `/users/me` 再重算路由（`src/app/router.tsx`），页面就地退回未登录形态，接口自身的错误文案由调用方就地展示。
- 后端缺的字段保留 `null` / `undefined`，不在前端补默认值。
- **schema 来自生成契约**：端点形状从 `src/shared/api/generated/zod.gen.ts` 取，不手写；业务约束（非空、互斥之类合同表达不了的）用 `.refine()` 叠在生成 schema 上。
- 测试：单测与被测源码同目录（`*.test.ts[x]`），用 `renderWithProviders`（`src/testing/render.tsx`）渲染真实 Provider 树，网络经 MSW（`src/testing/mocks`）；e2e 在 `e2e/`（Playwright，跑在 `pnpm dev:mock` 上，同一份 handlers）。

## 4. 改哪里、验哪里

改了代码跑 `pnpm ci:check`；动了依赖、vite 配置或路由树再加 `pnpm build`（合入前底线是 `pnpm verify`）。每加一个页面在同一个 PR 里补上它的单测或 e2e。外壳与 UI 视觉靠人工验收（见 §6）。

## 5. 禁止动作

- 前端 JavaScript 持有、存储或转发任何 token；恢复任何形态的 BFF、cookie 换发或 `producer_access_token`（[ADR-0001](docs/adr/0001-vite-spa-same-origin-no-bff.md)）。
- 权限门控引入前端用户名白名单——只判 `user.permissions` 后端权限字符串。
- UI 泄露内部协议字段（raw tool name、`member_id`、skill name、reference path、JSON 参数）。
- 组件自持主题状态——主题只有 `<html>` 上的 `.dark` 一个开关，由 `src/app/theme.ts` 统一切换，组件按 token 取色。
- 靠禁用 lint 规则、放宽 tsconfig 或改 design-guard 基线让代码通过。
- 自己写 toast 或 keyframes——toast 用 `@/shared/ui/toast`（sonner），进退场动画用 `animate-in / animate-out`（tw-animate-css）配 `duration-(--dur-*)` 与 `ease-(--ease-*)`。
- 新图形不进 `src/shared/icons/icon.tsx` 注册表就用；图标尺寸只取 `xs / sm / md / lg / xl` 五档。
- 测试里断言 className / style / 哈希类名、手搓 `fetch` stub（网络一律 MSW）、写内部状态探针组件——全部规则见 [docs/frontend-implementation.md](docs/frontend-implementation.md) 测试要求。

## 6. 需要人做的事

| 动作                                                 | 要求                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| UI 视觉验收                                          | 人工按 [design-system.html](../design-system.html) 规范：桌面 + 移动、无新增裸色/裸 z-index、中文表格列宽 |
| 生产部署反代配置                                     | 人工确认 `^/api` rewrite 语义与后端目标和 `vite.config.ts` 代理一致                                       |
| 运行时依赖升级（React / Vite / TanStack / radix 等） | 人工决策；升级后完整 `pnpm verify` 通过再合入                                                             |

## 7. 文档地图

| 文档                                                               | 内容                                                                                                                                                                            | 何时更新                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| [AGENTS.md](AGENTS.md)（本文）                                     | 命令、边界、验证、禁止动作、需要人做的事                                                                                                                                        | 命令入口 / 规则变化时        |
| [../docs/CONTEXT.md](../docs/CONTEXT.md)                           | 领域锚点（两端共用，在仓库根 `docs/`）：术语、不变量、禁止逻辑                                                                                                                  | 领域语言或不变量变化时       |
| [README.md](README.md)                                             | 项目入口：技术栈、目录结构                                                                                                                                                      | 结构变化时                   |
| [docs/frontend-implementation.md](docs/frontend-implementation.md) | 实现约定：组件、Hook、TS、测试                                                                                                                                                  | 实现约定变化时               |
| [../design-system.html](../design-system.html)                     | 契约文件（在仓库根目录）：颜色规范、排版与尺度、组件与状态与图标、结构模板、收敛原则；`:root` / `.dark` 两块是浅深两套 token 的唯一事实源，运行时镜像由 `pnpm lint:design` 对账 | token 家族或使用规则变化时   |
| [../contract/openapi.json](../contract/openapi.json)               | 后端导出的接口合同：端点、字段、状态码；前端类型与 zod 由它生成                                                                                                                 | 后端改端点后 `make contract` |
| [../contract/conventions.md](../contract/conventions.md)           | 合同表达不了的跨端约定：路由代理、双主体认证、命名、错误信封                                                                                                                    | 约定变化时                   |
| [docs/adr/](docs/adr/)                                             | 架构决策记录                                                                                                                                                                    | 做出难逆决策时新增           |
