# AGENTS.md — 前端开发约定

适用于 `web/`，与根 [AGENTS.md](../AGENTS.md) 一起遵守。目录与文档入口见 [README.md](README.md)；组件和测试规则见 [实现规范](docs/frontend-implementation.md)。

## 1. 命令

在 `web/` 执行。Node 与 pnpm 版本以 [package.json](package.json) 的 `engines`、`packageManager` 为准；全部命令见其中的 `scripts`。

| 命令                                | 用途                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| `pnpm dev`                          | 真实后端开发；启动参数见 [README](README.md#启动参数) |
| `pnpm dev:mock`                     | MSW 原型环境，未处理的 API 请求报错                   |
| `pnpm ci:check`                     | 格式、lint、设计系统、死代码、合同、类型与单测检查    |
| `pnpm verify`                       | `ci:check` 加生产构建，不含 e2e                       |
| `pnpm test`                         | Vitest 单测与组件测试                                 |
| `pnpm test:e2e`                     | Playwright，自动启动 `dev:mock`                       |
| `pnpm build` / `pnpm serve`         | 生产构建 / 构建后本地预览                             |
| `pnpm contract:generate`            | 从后端合同生成类型与 zod；修改顺序见根开发约定        |
| `pnpm format` / `pnpm format:check` | Prettier 格式化 / 检查                                |

真实后端与 mock 环境分开运行，不把真实认证与局部 mock 混进默认开发环境。

## 2. 职责与实现边界

- `src/routes/` 负责路由装配、守卫、search params 与跨 feature 组合；业务逻辑留在 feature。共用侧栏、登录弹窗、布局和右面板由 `_shell.tsx` 及同目录 `-` 前缀助手承载。
- feature 之间的稳定共用能力提取到 `shared/`，跨 feature 流程在 `app/` 或 `routes/` 组合。构建期助手放 `vite/`。
- 后端 REST 请求使用 `@/shared/api/client` 的 `apiFetch`；需要响应头或状态码时使用 `apiFetchWithResponse`。两者共用同源请求、鉴权回调和 zod 校验。裸 `fetch` 仅用于 OSS 预签名直传与外链素材下载。
- 接口 schema 使用 `src/shared/api/generated/` 的生成物；额外业务校验叠在生成 schema 上。后端字段缺失时保留其空值语义，不编造业务默认值。
- 登录与守卫遵守 [登录交互决策](docs/adr/0002-login-dialog-no-login-page.md)；权限门控使用后端 `user.permissions`，不使用用户名白名单。
- 不手改生成文件，不靠关闭检查、放宽类型配置或抬高 design-guard 基线让代码通过；修复存量后可以收紧基线。

依赖边界、导入入口、命名与语法由 [ESLint](eslint.config.js) 管理；死代码范围由 [knip](knip.json) 管理；视觉与 token 规则见根 [设计系统](../design-system.html)。

## 3. 验证

- 代码变更执行 `pnpm ci:check`，合入前通过 `pnpm verify`；核心用户旅程变更还要运行相关 Playwright 用例。CI 的 e2e 独立于 `verify` 执行。
- 新增页面、变更共享逻辑、跨层合同或用户行为时，按[实现规范的测试归层](docs/frontend-implementation.md#测试)补充或更新覆盖；纯文档或措辞变更检查格式和链接。
- UI 变更按[设计系统](../design-system.html)核对桌面与移动布局、浅深主题、键盘操作和中文长内容；截图位置见根开发约定。
- 修改生产反代时，验证路径 rewrite、WebSocket upgrade 与同源 Host / Origin；部署约定见[跨端合同](../contract/conventions.md)。
- 运行时依赖升级由开发者决定，升级后通过 `pnpm verify`；SSO / PMS 的真实验收要求见根开发约定。
