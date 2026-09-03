# Cue

AI 视频创作前端。Vite + React 19 纯 SPA，TanStack Router 文件式路由 + TanStack Query 数据层，经同源代理访问后端。

## 技术栈

- 构建：Vite 8 + TypeScript（strict）
- 路由：TanStack Router（文件式，`src/routes/`，路由树自动生成到 `src/routeTree.gen.ts`）
- 数据：TanStack Query v5 + react-query-auth
- 契约：后端导出 `contract/openapi.json`，`@hey-api/openapi-ts` 生成类型与 zod 到 `src/shared/api/generated`
- 样式：Tailwind CSS v4 + tw-animate-css（进退场动画）
- 组件：radix-ui primitive 收在 `shared/ui` 契约层；图标 lucide-react 收在 `shared/icons` 注册表；toast 用 sonner
- 测试：Vitest（jsdom）+ Testing Library + MSW；`renderWithProviders` 渲染真实 Provider 树，网络一律 MSW
- 开发原型：MSW（仅 `pnpm dev:mock` 环境，与单测共用 handlers）
- Lint/格式化：ESLint + Prettier + design-guard + knip

## 项目结构

```text
.
├── public/                     # 静态资源（字体等）
├── scripts/
│   ├── check-design-system.mjs # 规范 ↔ 运行时 token 双向对账
│   ├── check-openapi-contract.mjs # 契约对账（pnpm contract:check）
│   ├── design-guard.mjs        # 设计系统守卫（pnpm lint:design）
│   ├── start-dev.sh            # 开发服务器（默认 0.0.0.0:3013）
│   └── start-prod.sh           # 本地验证生产构建（build + vite preview）
├── vite/                       # 构建期助手（同源代理、dev profile），归 tsconfig.node.json
├── knip.json                   # 死代码检查配置（pnpm lint:dead）
├── vitest.config.ts            # 单测配置（pnpm test）
└── src/
    ├── main.tsx                # 入口
    ├── app/                    # 应用壳：providers、router 装配、全局样式与主题
    ├── routes/                 # 文件式路由，只做装配；_shell.tsx 提供共用侧栏与登录弹窗（实现拆在 -app-sidebar.tsx、-login-prompt.tsx）
    ├── features/               # 业务模块
    │   ├── auth/               # 登录、SSO、用户菜单
    │   ├── collections/        # 合集
    │   ├── conversations/      # 对话：侧栏用的接口、归属与搜索弹窗、会话页
    │   ├── home/               # 首页
    │   ├── storyboard/         # 分镜工作台：产物面板里的镜头组渲染器
    │   └── tasks/              # 需求单
    ├── shared/                 # 共用层
    │   ├── api/                # apiFetch、query-client
    │   ├── auth/               # 会话、权限判定、路由守卫
    │   ├── icons/              # 图标注册表（Icon / IconName，唯一图标入口）
    │   ├── lib/                # 通用工具
    │   ├── transcript/         # 对话内容：订阅连接、读取端；vendor/ 是照抄来的协议 reducer
    │   ├── ui/                 # 契约组件：button / chip / composer / dialog / field / media-lightbox / menu / popup / tag / toast
    │   └── workbench/          # 产物面板宿主与类型注册表（渲染器在 features/，登记在 app/）
    └── testing/                # 测试基建：renderWithProviders、MSW handlers / server、dev:mock 入口
```

命令与边界见 [AGENTS.md](AGENTS.md)。
