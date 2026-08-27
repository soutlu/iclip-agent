# Producer

AI 视频创作前端。Vite + React 19 纯 SPA，TanStack Router 文件式路由 + TanStack Query 数据层，经同源代理访问后端。

**当前处在重写起点**：旧页面层已整体删除，只留登录、鉴权外壳与一个空首页；设计系统、图标注册表与契约组件保留，新页面从这套地基往外长。

## 技术栈

- 构建：Vite 8 + TypeScript（strict）
- 路由：TanStack Router（文件式，`src/routes/`，路由树自动生成到 `src/routeTree.gen.ts`）
- 数据：TanStack Query v5 + react-query-auth（HttpOnly cookie 会话，`GET /users/me` 为登录态唯一事实源）
- 契约：后端导出 `contract/openapi.json`，`@hey-api/openapi-ts` 生成类型与 zod 到 `src/shared/api/generated`
- 样式：Tailwind CSS v4 + tw-animate-css（进退场动画）
- 组件：radix-ui primitive 收在 `shared/ui` 契约层；图标 lucide-react 收在 `shared/icons` 注册表；toast 用 sonner
- 测试：Vitest（jsdom）+ Testing Library + MSW；`renderWithProviders` 渲染真实 Provider 树，网络一律 MSW
- 开发原型：MSW（仅 `pnpm dev:mock` 环境，与单测共用 handlers）
- 表单：TanStack Form——已定为表单库，首个新表单接入时安装（登录表单是重写前的手写状态，届时一起迁）
- Lint/格式化：ESLint（flat config，boundaries 架构守卫）+ Prettier + design-guard（设计系统守卫）+ knip（死代码门禁）

## 项目结构

```text
.
├── public/                     # 静态资源（字体等）
├── scripts/
│   ├── check-design-system.mjs # 规范 ↔ 运行时 token 双向对账
│   ├── check-openapi-contract.mjs # 契约漂移门禁（pnpm contract:check）
│   ├── design-guard.mjs        # 设计系统守卫（pnpm lint:design）
│   ├── start-dev.sh            # 开发服务器（默认 0.0.0.0:3013）
│   └── start-prod.sh           # 本地验证生产构建（build + vite preview）
├── vite/                       # 构建期助手（同源代理、dev profile），归 tsconfig.node.json
├── knip.json                   # 死代码门禁配置（pnpm lint:dead）
├── vitest.config.ts            # 单测配置（pnpm test）
└── src/
    ├── main.tsx                # 入口
    ├── app/                    # 应用壳：providers、router 装配、全局样式与主题
    ├── routes/                 # 文件式路由 = 薄胶水层；_authed.tsx 提供登录页共用页头
    ├── features/               # 业务竖切（互相完全隔离，禁止跨 feature）
    │   ├── auth/               # 登录、SSO、用户菜单
    │   └── home/               # 首页（待重建）
    ├── shared/                 # 横切能力（不依赖业务层）
    │   ├── api/                # apiFetch、query-client
    │   ├── auth/               # 会话、权限判定、路由守卫
    │   ├── config/             # env.ts 环境变量唯一入口
    │   ├── icons/              # 图标注册表（Icon / IconName，唯一图标入口）
    │   ├── lib/                # 通用工具
    │   └── ui/                 # 契约组件：button / chip / dialog / field / menu / popup / tag / toast
    └── testing/                # 测试基建：renderWithProviders、MSW handlers / server、dev:mock 入口（业务代码不得引用）
```

## 分层约定

- `src/routes`：只做 `createFileRoute` 装配、守卫与 search params 校验，不写业务逻辑。
- `src/features`：业务代码默认先进 feature；**跨 feature 一律禁止**（含对方 `index.ts`），共用的下沉 `shared/` 或在 routes / app 层组装。
- `src/shared`：只放明确跨 feature 复用的通用能力；不能反向依赖 `features`。
- 文件名 kebab-case、只用具名导出（`routes/` 按 TanStack 约定命名除外），ESLint 强制。
- 环境变量只从 `@/shared/config/env` 读取（zod 校验）。
- 后端 REST 请求一律经 `apiFetch(path, schema)` 在边界处过 zod（`@/shared/api/client`）；裸 fetch 仅限 OSS 直传 PUT、外链下载两类非 REST 场景。

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
pnpm lint:dead       # knip 死代码门禁
pnpm test            # Vitest 单测
pnpm format          # Prettier 全量格式化
pnpm contract:generate # 按 contract/openapi.json 生成类型与 zod
pnpm contract:check  # 契约漂移门禁
pnpm typecheck       # TypeScript 类型检查
pnpm ci:check        # format:check + lint + lint:design + lint:dead + contract:check + typecheck + test（提交前跑）
pnpm verify          # ci:check + build（合入 / 发布前跑）
```

## 后端代理

`pnpm dev` 不注册浏览器 MSW：`/api` 由 Vite 同源代理转发到后端，目标由 shell 环境变量 `VITE_BACKEND_PROXY_TARGET` 控制（默认 `http://127.0.0.1:7788`）。会话 cookie 是 host-only 的，不跨 `localhost` / `127.0.0.1` 共享——同一登录会话期间不要切换 Host。正式部署为纯静态 `dist/` + 同源反向代理；决策与硬约束见 [docs/adr/0001](docs/adr/0001-vite-spa-same-origin-no-bff.md)。

`pnpm dev:mock` 是唯一注册浏览器 MSW 的入口：注册 canonical handlers，未处理的 `/api` 请求显式报错，并等待 worker 就绪后再挂载应用。普通 `pnpm dev`、预览和生产构建不包含 MSW 启动逻辑。
