# AGENTS.md — Producer 前端控制面

> 面向在本仓库工作的 AI agent 与新成员的项目记忆：命令、边界、验证矩阵、禁止动作、人类门禁。
> 本文只做控制面，不做说明书——细节一律指向事实源文档：
> 领域术语与不变量 → [CONTEXT.md](CONTEXT.md) · 架构与结构 → [README.md](README.md) · 实现规范 → [docs/frontend-implementation.md](docs/frontend-implementation.md) · 视觉规范 → [../design-system.html](../design-system.html)（唯一设计规范文档，在仓库根目录） · 后端接口 → [../contract/openapi.json](../contract/openapi.json)（端点、字段、状态码）与 [../contract/conventions.md](../contract/conventions.md)（合同表达不了的约定） · 决策 → [docs/adr/](docs/adr/)

## 1. 项目速览

AI 视频创作前端。Vite 8 + React 19 纯 SPA：TanStack Router 文件式路由 + TanStack Query 数据层，浏览器经同源 `/api` 访问后端。**无 BFF、前端不持有 token**（决策与硬约束见 [docs/adr/0001](docs/adr/0001-vite-spa-same-origin-no-bff.md)）。Node ≥ 22.18 + pnpm（`lint:design` 的自测直接 import `.ts`，靠 Node 自带的类型剥离，22.18 起才默认开着）；TypeScript strict。

**前端处在重写起点。** 旧的页面层（画布、聊天、Storyboard、Task、产物渲染、管理端）已整体删除，只留登录、鉴权外壳和一个空首页。留下来的是重写要站的地基：`design-system.html` 的 token 与契约、`shared/icons` 图标注册表、`shared/ui` 九件契约组件、design-guard 与对账脚本。新页面从这套地基往外长，不再从 feature CSS 起步。

**测试从登录表单起步**：Vitest + Testing Library + MSW 已就位（`src/testing/`），现有用例只有 `login-form.test.tsx`；每加回一个页面，同一个 PR 补它的测试。现行机械门禁 = `pnpm ci:check`（format / lint / lint:design / lint:dead / contract:check / typecheck / test）+ `pnpm build`。

## 2. 统一命令入口（pnpm scripts）

所有常用命令统一走 `package.json` scripts；新增命令必须加进去，不散落在 README 或口头约定里。

| 命令                                | 作用                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm install`                      | 安装依赖（本地 git hooks 由根仓 `make hooks` 安装）                                           |
| `pnpm dev`                          | 开发服务器（默认 0.0.0.0:3013；全部 `/api` 请求代理到真实后端）                               |
| `pnpm dev:mock`                     | 浏览器 MSW 原型环境（默认 0.0.0.0:3014；不连接真实后端，未处理 `/api` 请求显式报错）          |
| `pnpm lint` / `pnpm lint:fix`       | ESLint（flat config，boundaries 架构守卫）                                                    |
| `pnpm lint:design`                  | 设计系统门禁：规范 ↔ 运行时 token 对账（含自测）+ design-guard 硬编码扫描                     |
| `pnpm lint:dead`                    | knip：没人引用的文件、导出、依赖即红                                                          |
| `pnpm test`                         | Vitest 单测（jsdom + Testing Library + MSW）                                                  |
| `pnpm contract:generate`            | 按 `contract/openapi.json` 重新生成 `src/shared/api/generated`（类型 + zod）                  |
| `pnpm contract:check`               | 契约漂移门禁：入库生成物必须与合同逐字节一致                                                  |
| `pnpm typecheck`                    | `tsc -b` 全量类型检查                                                                         |
| `pnpm build`                        | `tsc -b && vite build`                                                                        |
| `pnpm serve`                        | 本地验证生产构建（build + vite preview）                                                      |
| `pnpm format` / `pnpm format:check` | Prettier                                                                                      |
| `pnpm ci:check`                     | 提交前门禁：format:check → lint → lint:design → lint:dead → contract:check → typecheck → test |
| `pnpm verify`                       | 合入 / 发布前完整检查：ci:check 全项 + build                                                  |

## 3. 边界（哪里能改什么）

分层与依赖方向由 ESLint boundaries 机械强制（违反即报错；测试文件与 `src/testing` 豁免，见 §7）：

- 依赖单向向下：`main.tsx → app/`（壳与 router 装配）`→ routes/`（薄胶水）`→ features/<name>`（业务竖切）`→ shared/`（横切）。
- `src/routes/**` 只做 `createFileRoute` 装配、`beforeLoad` 守卫与 search params 校验，不写业务逻辑；`src/routeTree.gen.ts` 自动生成，不手改。
- **跨 feature 一律禁止**（机械强制），包括对方的 `index.ts`。两个 feature 要共用东西只有两条路：下沉 `shared/`，或者在 routes / app 层组装。旧前端留了「只走 index.ts」这个口子，最后长出 69 条跨 feature 边、把 index.ts 撑成事实上的公共层。
- 每个登录页都要有的外壳（页头、用户菜单）放 `src/routes/_authed.tsx`，不塞进任何 feature——塞进去就会逼出跨 feature 依赖。
- `src/shared/**` 只放领域无关的横切能力，不得反向依赖 `features`；`src/testing/**` 是测试基建，业务代码 import 会被拦截。
- 环境变量只经 `src/shared/config/env.ts` 的 zod schema 读取（`VITE_*`）；新变量先在 schema 声明。
- 后端 REST 请求一律经 `apiFetch(path, schema)`（`@/shared/api/client`，响应在边界处过 zod）；裸 fetch 仅限两类非 REST 场景：OSS 预签名直传 PUT、外链素材下载。
- 构建期代码（vite 代理、dev profile）放 `vite/`，归 `tsconfig.node.json`；`src/` 不带 Node 类型，浏览器代码写 `process.env` 会直接编译失败。
- **schema 来自生成契约**：`src/shared/api/generated/zod.gen.ts` 由 `contract/openapi.json` 生成，端点形状不手写。业务约束（非空、互斥之类合同表达不了的）用 `.refine()` 叠在生成 schema 上。
- 文件名 kebab-case、只用具名导出（`routes/` 按 TanStack 约定命名，不在此列），ESLint 强制。
- 测试：单测与被测源码同目录（`*.test.ts[x]`），用 `renderWithProviders`（`src/testing/render.tsx`）渲染真实 Provider 树，网络经 MSW（`src/testing/mocks`）；e2e 在 `e2e/`（尚未建）。

## 4. Verification Matrix

每个 surface 绑定验证命令与证据。**改了哪个面，就交哪份证据**；「证据」指可展示的输出（命令输出 / HTTP payload / 截图 / 构建产物），不是「我觉得没问题」。还没有测试覆盖的行为类 surface 先由人工验收兜底；补上测试就把那一行改成可执行的命令。

| Surface                                       | 现行验证          | 证据                                                                                   |
| --------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| 全仓（合入 / 发布前底线）                     | `pnpm verify`     | Prettier / ESLint / design-guard 零输出；tsc 零错误；构建成功                          |
| 架构分层（新增文件 / 移动模块 / 调整 import） | `pnpm lint`       | boundaries 无「依赖方向违规」报错                                                      |
| 生产构建（改依赖 / vite 配置 / 路由树）       | `pnpm build`      | `dist/` 产物生成，构建零错误                                                           |
| 登录表单                                      | `pnpm test`       | `login-form.test.tsx`：SSO 开关下密码区的显隐、表单登录后跳 nextPath、失败展示后端文案 |
| 登录态与路由守卫                              | 人工验收          | `/users/me` 是登录态唯一事实源；守卫与权限门控只按后端权限字符串放行 / 拦截            |
| UI 视觉（token / 布局 / 深浅两套主题）        | 人工验收（见 §6） | 桌面 + 移动截图；无新增裸色 / 裸 z-index                                               |

重写期间每加回一个页面，就在这张表里补一行，并且**同一个 PR 里把对应的测试一起写**——旧前端就是靠「先补页面、测试以后再说」把 8 行拖成了人工验收。

## 5. 禁止动作

- 前端 JavaScript 持有、存储或转发任何 token；恢复任何形态的 BFF、cookie 换发或 `producer_access_token`（[ADR-0001](docs/adr/0001-vite-spa-same-origin-no-bff.md)）。
- 跨 feature import——包括对方 `index.ts`。共用的东西下沉 `shared/`，或在 routes / app 层组装。
- 权限门控引入前端用户名白名单——只判 `user.permissions` 后端权限字符串。
- 绕过 `apiFetch(path, schema)` 写裸 fetch REST（§3 两类豁免之外）；绕过 `env.ts` 直接读 `import.meta.env`。
- 手改 `src/routeTree.gen.ts`。
- 组件自持主题状态——主题只有 `<html>` 上的 `.dark` 一个开关，由 `src/app/theme.ts` 统一切换，组件按 token 取色、不判断当前是明是暗。
- 靠禁用 lint 规则、放宽 tsconfig 或改 design-guard 基线让代码通过。
- UI 泄露内部协议字段（raw tool name、`member_id`、skill name、reference path、JSON 参数）。
- 组件里新增与既有 token 等价的裸色值、裸 z-index 或一次性阴影——先补 `globals.css` token。
- 手写后端端点的请求 / 响应 schema——形状从 `@/shared/api/generated/zod.gen` 取，后端改了跑 `make contract` + `pnpm contract:generate`。
- 手写已有轮子：toast 用 `@/shared/ui/toast`（sonner），进退场动画用 `animate-in / animate-out`（tw-animate-css）配 `duration-(--dur-*)` 与 `ease-(--ease-*)`，不自己写 keyframes。
- 组件直接 import `lucide-react`——图标只经 `@/shared/icons` 的 `Icon` 按语义名称使用，新图形先加进 `src/shared/icons/icon.tsx` 注册表；尺寸只取 `xs / sm / md / lg / xl` 五档。
- 业务层直连 `radix-ui` 的 `Dialog` / `DropdownMenu` / `Popover` / `ToggleGroup`——这四个已有契约组件（`@/shared/ui` 下的 dialog / menu / popup / chip）；按钮、输入、标签、提示条同样先看 `shared/ui` 有没有，不在 feature CSS 里另起一套。
- 测试里 `vi.mock` 同仓模块（ESLint 拦）、断言 className/style/哈希类名、手搓 `fetch` stub（网络一律 MSW）、写内部状态探针组件——行为归层与全部规则见 [docs/frontend-implementation.md](docs/frontend-implementation.md) 测试要求。
- 为「以后可能用」加依赖或留导出——knip 见到没人引用的就红；要用的时候再加。

## 6. 人类门禁

以下动作机器不得自动执行，需要人做决定或人交证据：

| 动作                                                 | 门禁                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| UI 视觉验收                                          | 人工按 [design-system.html](../design-system.html) 规范：桌面 + 移动、无新增裸色/裸 z-index、中文表格列宽 |
| 生产部署反代配置                                     | 人工确认 `^/api` rewrite 语义与后端目标和 `vite.config.ts` 代理一致                                       |
| 运行时依赖升级（React / Vite / TanStack / radix 等） | 人工决策；升级后完整 `pnpm verify` 通过再合入                                                             |

## 7. 机械 Guardrails 现状

| Guardrail    | 状态                                                                                                                                                                                                                      | 位置 / 说明                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lint         | ✅ ESLint flat config，`--max-warnings 0`（warning 也红）；禁非空断言 `!`、switch 必须穷尽；只用具名导出；`import.meta.env` 只许在 `src/shared/config/env.ts`                                                             | `eslint.config.js`；typescript-eslint + react-hooks（含 React Compiler 诊断）+ @eslint-react（key、嵌套组件定义、无用 fragment、button type、target=_blank）+ react-refresh + TanStack Query 插件 |
| typecheck    | ✅ tsc strict + `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `noPropertyAccessFromIndexSignature` / `erasableSyntaxOnly`（enum、namespace 编译期拒绝）/ `verbatimModuleSyntax`（`import type` 编译期强制） | `tsconfig.app.json`；`pnpm typecheck`                                                                                                                                                             |
| 架构约束     | ✅ eslint-plugin-boundaries 依赖图（app / feature / shared / testing 四类元素；**跨 feature 一律禁止**）                                                                                                                  | `eslint.config.js`                                                                                                                                                                                |
| 边界校验     | ✅ zod：`apiFetch` 响应过生成契约；环境变量入口 `src/shared/config/env.ts`（当前没有任何 `VITE_*` 变量，文件不存在，需要时按此路径建）                                                                                    | `src/shared/api/client`；lint 把 `import.meta.env` 锁在 env.ts                                                                                                                                    |
| 死代码       | ✅ knip：没人引用的文件、导出、依赖即红。`shared/ui/*/index.ts` 与 `shared/icons/index.ts` 是库入口——契约组件按设计系统的表备着，不按页面用量删                                                                           | `knip.json`；`pnpm lint:dead`                                                                                                                                                                     |
| 设计系统守卫 | ✅ design-guard 棘轮基线（裸色、任意值阴影/圆角/字号、裸 z-index、outline-none 只降不升）                                                                                                                                 | `scripts/design-guard.mjs` + `scripts/design-guard.baseline.json`；`pnpm lint:design`                                                                                                             |
| 图标入口     | ✅ `no-restricted-imports` 禁止 `lucide-react` 直连，只放行注册表本体                                                                                                                                                     | `eslint.config.js`；注册表在 `src/shared/icons/`                                                                                                                                                  |
| 契约漂移     | ✅ 生成物必须与 `contract/openapi.json` 逐字节一致；合同本身与后端的一致性由根仓 `make check` 的 contract-check 保证                                                                                                      | `scripts/check-openapi-contract.mjs`；`pnpm contract:check`                                                                                                                                       |
| 组件入口     | ✅ `no-restricted-imports` 禁止业务层直连四个已封装的 radix primitive，只放行 `src/shared/ui/**`                                                                                                                          | `eslint.config.js`；契约组件在 `src/shared/ui/`                                                                                                                                                   |
| 可访问性     | ✅ eslint-plugin-jsx-a11y-x recommended                                                                                                                                                                                   | `eslint.config.js`                                                                                                                                                                                |
| 自动化测试   | ✅ Vitest（jsdom）+ Testing Library + MSW，在 `ci:check` 内；`vi.mock` 同仓模块由 ESLint 拦，其余测试规则见 [docs/frontend-implementation.md](docs/frontend-implementation.md)                                            | `vitest.config.ts`、`src/testing/`；用例与源码同目录，每加回一个页面同一个 PR 补测试                                                                                                              |
| pre-commit   | ✅ 由根仓 pre-commit 框架跑 web lint-staged（eslint --fix + prettier）                                                                                                                                                    | 根仓 `.pre-commit-config.yaml`；lint-staged 配置在 `package.json`                                                                                                                                 |
| Node 版本    | ✅ `.npmrc` `engine-strict=true`：低于 `engines.node` 的 Node 上 `pnpm install` 直接失败                                                                                                                                  | `.npmrc` + `package.json` engines                                                                                                                                                                 |
| pre-push     | ⚠️ 根仓 pre-push 只跑 server pyright，web 无 pre-push 检查（防线在 CI + 人类合并门禁）                                                                                                                                    | 根仓 `.pre-commit-config.yaml`                                                                                                                                                                    |
| CI           | ✅ monorepo 根级 GitHub Actions web job：`pnpm ci:check` + build                                                                                                                                                          | 根仓 `.github/workflows/ci.yml`（push main / PR）                                                                                                                                                 |
| 格式         | ✅ Prettier（含 tailwindcss class 排序插件）                                                                                                                                                                              | `prettier.config.js`；`docs/` 保持忽略，文档格式手工维护                                                                                                                                          |
| 命名与导出   | ✅ eslint-plugin-check-file：`src/{app,features,shared,testing}` 下文件名 kebab-case（`routes/` 例外）；`no-restricted-syntax` 禁 default 导出                                                                            | `eslint.config.js`                                                                                                                                                                                |

## 8. 文档地图

| 文档                                                               | 内容                                                                                                                                                                            | 何时更新                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| [AGENTS.md](AGENTS.md)（本文）                                     | 控制面：命令、边界、验证矩阵、禁止动作、人类门禁                                                                                                                                | 命令入口 / 红线 / 门禁变化时 |
| [CONTEXT.md](CONTEXT.md)                                           | 领域锚点：术语、上下文、不变量、禁止逻辑                                                                                                                                        | 领域语言或不变量变化时       |
| [README.md](README.md)                                             | 项目入口：技术栈、目录结构、分层约定、启动方式                                                                                                                                  | 结构或启动方式变化时         |
| [docs/frontend-implementation.md](docs/frontend-implementation.md) | 门禁之外仍需人判断的实现约定：组件、Hook、TS、测试                                                                                                                              | 实现约定变化时               |
| [../design-system.html](../design-system.html)                     | 契约文件（在仓库根目录）：颜色规范、排版与尺度、组件与状态与图标、结构模板、收敛原则；`:root` / `.dark` 两块是浅深两套 token 的唯一事实源，运行时镜像由 `pnpm lint:design` 对账 | token 家族或使用规则变化时   |
| [../contract/openapi.json](../contract/openapi.json)               | 后端导出的接口合同：端点、字段、状态码；前端类型与 zod 由它生成                                                                                                                 | 后端改端点后 `make contract` |
| [../contract/conventions.md](../contract/conventions.md)           | 合同表达不了的跨端约定：路由代理、双主体认证、命名、错误信封                                                                                                                    | 约定变化时                   |
| [docs/adr/](docs/adr/)                                             | 架构决策记录                                                                                                                                                                    | 做出难逆决策时新增           |
| [docs/archive/](docs/archive/)                                     | 已完成计划留档（不再是事实源）                                                                                                                                                  | 计划完结归档时               |

计划文档生命周期：阶段性计划放 `docs/`，推进期间是对应工作的事实源；完成后把长期事实沉淀进 README / `docs/adr/`，原文标注状态移入 `docs/archive/`。新增可执行约定时更新对应专题文档；删除旧规范时同步更新本文件的路由表。
