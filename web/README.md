# Producer

AI 视频创作前端。Vite + React 19 纯 SPA，TanStack Router 文件式路由 + TanStack Query 数据层，经同源代理访问后端。冻结代码仍消费旧系统合同，尚未整体切换到本仓 `server/`。

## 技术栈

- 构建：Vite 8 + TypeScript（strict）
- 路由：TanStack Router（文件式，`src/routes/`，路由树自动生成到 `src/routeTree.gen.ts`）
- 数据：TanStack Query v5 + react-query-auth（HttpOnly cookie 会话，`GET /users/me` 为登录态唯一事实源）
- 状态：Zustand（feature 内 store）
- 样式：Tailwind CSS v4
- 开发原型：MSW（仅 `pnpm dev:mock` 环境）
- Lint/格式化：ESLint（flat config，boundaries 架构守卫）+ Prettier + design-guard（设计系统守卫）

## 项目结构

```text
.
├── public/                     # 静态资源（字体等）
├── scripts/
│   ├── design-guard.mjs        # 设计系统守卫（pnpm lint:design）
│   ├── start-dev.sh            # 开发服务器（默认 0.0.0.0:3013）
│   └── start-prod.sh           # 本地验证生产构建（build + vite preview）
└── src/
    ├── main.tsx                # 入口
    ├── app/                    # 应用壳：providers、router 装配、全局样式
    ├── routes/                 # 文件式路由 = 薄胶水层（守卫 + 组装 feature 页面）
    ├── features/               # 业务竖切（互相隔离，对外只经各自 index.ts）
    │   ├── admin-users/        # 管理端用户管理
    │   ├── analytics/          # 用量分析
    │   ├── artifacts/          # 结构化产物解析与渲染
    │   ├── auth/               # 登录、SSO、会话
    │   ├── chat/               # 项目聊天与 AG-UI 运行态
    │   ├── home/               # 首页工作台
    │   ├── project-canvas/     # 项目画布、节点与导出
    │   ├── project-workspace/  # 项目工作台壳与视频合成
    │   ├── projects/           # 项目 API 与生成事件（WS）
    │   ├── conversations/      # 对话（AG-UI threadId）与它的工作区文件
    │   ├── storyboards/        # 一张需求单的 Storyboard 工作台与调试页
    │   └── tasks/              # Video Task 下发与确认
    ├── shared/                 # 横切能力（不依赖业务层）
    │   ├── api/                # apiFetch、query-client
    │   ├── config/             # env.ts 环境变量唯一入口
    │   ├── lib/                # 通用工具
    │   └── ...                 # agui / auth / composer / editor / hooks / markdown / ui
    └── testing/                # 开发原型基建：MSW mocks 与 dev:mock 入口（业务代码不得引用）
```

## 分层约定

- `src/routes`：只做 `createFileRoute` 装配、守卫与 search params 校验，不写业务逻辑。
- `src/features`：业务代码默认先进 feature；每个 feature 经自己的 `index.ts` 暴露公共 API；禁止跨 feature 深层 import。
- `src/shared`：只放明确跨 feature 复用的通用能力；不能反向依赖 `features`。
- 环境变量只从 `@/shared/config/env` 读取（zod 校验）。
- 后端 REST 请求一律经 `apiFetch(path, schema)` 在边界处过 zod（`@/shared/api/client`）；裸 fetch 仅限 AG-UI SSE run、OSS 直传 PUT、外链下载。

完整边界规则、验证矩阵与禁止动作见 [AGENTS.md](AGENTS.md)。

## 常用命令

```bash
pnpm install         # 安装依赖（Node ≥ 22.18 + pnpm）
pnpm dev             # 开发服务器（默认 3013；API 连接真实后端）
pnpm dev:mock        # 浏览器 MSW 原型环境（默认端口 3014，不连接真实后端）
pnpm build           # tsc -b && vite build
pnpm serve           # 本地验证生产构建（build + vite preview）
pnpm lint            # ESLint
pnpm lint:design     # 设计系统守卫
pnpm format          # Prettier 全量格式化
pnpm typecheck       # TypeScript 类型检查
pnpm ci:check        # format:check + lint + lint:design + typecheck（提交前跑）
pnpm verify          # ci:check 全项 + build（合入 / 发布前跑）
```

## 后端代理

`pnpm dev` 不注册浏览器 MSW：`/api` 由 Vite 同源代理转发到后端，目标由 shell 环境变量 `VITE_BACKEND_PROXY_TARGET` 控制（默认 `http://127.0.0.1:7788`）。会话 cookie 是 host-only 的，不跨 `localhost` / `127.0.0.1` 共享——同一登录会话期间不要切换 Host。正式部署为纯静态 `dist/` + 同源反向代理；决策与硬约束见 [docs/adr/0001](docs/adr/0001-vite-spa-same-origin-no-bff.md)。

`pnpm dev:mock` 是唯一注册浏览器 MSW 的入口：注册 canonical handlers，未处理的 `/api` 请求显式报错，并等待 worker 就绪后再挂载应用。普通 `pnpm dev`、预览和生产构建不包含 MSW 启动逻辑。
