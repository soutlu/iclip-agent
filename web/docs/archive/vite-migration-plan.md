# Producer 前端迁移方案：Next.js → Vite 纯 SPA

> 状态：**已实施**（2026-07-08，`feat/vite-migration` 分支，验证全绿：lint / typecheck / 67 测试文件 464 用例 / 生产构建）
> 目标架构参考：`/Volumes/workspace/code/idesign/idesign_forent`
> 关联仓库：`iclip_agent`（FastAPI 后端，同 workspace 下独立仓库）
> 变更记录：
> - 2026-07-08 临时用户白名单已从 BFF 直接删除（已有用户权限体系，临时措施不再保留），Phase 0 相应缩减。
> - 2026-07-08 Phase 1~5 实施完成。实施勘误：后端 `GET /users/me` 返回的本就是 `{user: {...camelCase}}` 包装（`identity/api.py` `read_me`），并非本文原稿所写的"裸 user"——客户端 mapper 原样平移，仅路径从 `/api/auth/me` 换成 `/api/users/me`。
> - 实施要点：`VITE_BACKEND_PROXY_TARGET` 是 **shell 环境变量**（vite.config.ts 经 `process.env` 读取，不走 .env 文件）；`.env.local` 旧变量已清空；`tsconfig.app.json` types 含 `node`（单测使用 node 全局）；biome 排除 `src/routeTree.gen.ts`；页面组件归位到 `src/features/{home,analytics,project-workspace}/`；Playwright webServer 本地起 vite dev、CI 用 `vite preview` 跑 dist。
> - 待后端环境可用时人工验证：账密登录、SSO 闭环、WS 推送、AG-UI SSE 流式、文件上传（本机 Postgres 不可用，后端起不来，只验证到 vite proxy rewrite 转发正确）。

---

## 1. 背景与目标

Producer 当前是 Next.js 16（App Router）应用，实际形态是"重客户端 + BFF"：

- 87 个 `'use client'` 组件承载全部业务 UI（画布、聊天、富文本、artifacts）；
- App Router 主要被当作路由壳（仅 4 个页面）+ BFF 代理层（24 个 API route）；
- BFF 的核心职能是认证转换：把后端 fastapi-users 签发的 `iclip_session` cookie（JWT）换发成前端自己的 HttpOnly cookie `producer_access_token`，并在代理转发时还原。

迁移目标：**对齐 idesign_forent 的"无 BFF 纯 SPA"架构**——

| 维度 | 现状（Next.js） | 目标（Vite SPA） |
|---|---|---|
| 构建 | Next.js 16 | Vite 8 + `@vitejs/plugin-react` |
| 路由 | App Router（4 页面） | TanStack Router 文件式路由（`@tanstack/router-plugin`，autoCodeSplitting） |
| 认证 | BFF cookie 换发（`producer_access_token`） | 后端 HttpOnly cookie `iclip_session` 直达浏览器，前端不持有 token |
| 后端连接 | Node BFF 服务端转发 | 同源代理（dev: vite proxy；prod: 反代），cookie 自动携带 |
| 会话事实源 | BFF `/api/auth/me` | `GET /users/me` 进 TanStack Query 缓存（react-query-auth） |
| 页面守卫 | `src/proxy.ts`（Next 16 middleware） | pathless layout route `_authed.tsx` 的 `beforeLoad` 异步守卫 |
| 部署 | `next start` Node 服务（:3013） | 纯静态 `dist/` + 反向代理 |

---

## 2. 核心决策：拆掉 BFF

### 2.1 结论

**删除整个 BFF 层（`src/app/api/` 24 个 route + `src/server/` + `src/proxy.ts`），浏览器经同源代理直连 iclip_agent 后端。** 不采用"把 BFF 抽成独立 Node 服务"的方案。

```
现状（BFF 架构）                          目标（idesign_forent 同构）
╭─────────╮                              ╭─────────╮
│ Browser │ producer_access_token        │ Browser │ iclip_session
╰────┬────╯ (BFF 换发的 cookie)          ╰────┬────╯ (后端直接种的 cookie)
     │                                        │
     ▼                                        ▼
╭──────────────────╮                     ╭──────────────────────╮
│ Next.js BFF      │                     │ 同源代理              │
│ · 24 个 route    │                     │ dev: vite proxy      │
│ · cookie 换发    │                     │ prod: nginx/反代      │
│ · 白名单         │                     │ （仅转发 /api → 后端）│
│ · ws-ticket     │                      ╰──────────┬───────────╯
╰────┬─────────────╯                                │
     │ cookie: iclip_session=<jwt>                  │ cookie 原样透传
     ▼                                              ▼
╭──────────────╮                         ╭──────────────────────╮
│ FastAPI 后端 │                         │ FastAPI 后端          │
╰──────────────╯                         │ + 白名单强制（新增）   │
                                         ╰──────────────────────╯
```

### 2.2 可行性论证（BFF 四个职能逐一核实）

| BFF 职能 | 同源架构下的替代 | 后端证据（iclip_agent） |
|---|---|---|
| cookie 换发（`iclip_session` → `producer_access_token`，`src/server/producer-bff-auth.ts`） | **不再需要**。同源下后端 `Set-Cookie` 直达浏览器 | `iclip/modules/identity/middleware.py:184-193`：`CookieTransport(cookie_name, cookie_max_age, cookie_secure, cookie_samesite="lax")`，`cookie_secure` 可配置 |
| 18 个纯代理 route（注入 `authorization: Bearer` + `cookie: iclip_session`） | **不再需要**。同源请求自动携带 cookie，后端本来就读 cookie | 后端路由挂根路径（`/auth`、`/projects`、`/analytics`、`/sessions`、`/teams/{id}`…），代理只需去掉 `/api` 前缀 |
| `ws-ticket`（把 HttpOnly cookie 转成浏览器可读 token，供 WS `bearer.<token>` 子协议） | **不再需要**。后端 WS 已支持 cookie 鉴权 | `iclip/modules/generation/ws_api.py:97-107`，注释原文："鉴权走会话 cookie（浏览器在 WS 握手时自动携带）"；`verify_session_token(websocket.cookies.get(cookie_name))` |
| SSO landing（服务端换会话 + 回跳） | **改为前端公开路由**，调后端 callback | `iclip/modules/identity/api.py:135-141`：`GET /auth/sso/callback?jwt=` 的 docstring："前端落地路由把 SSO 回跳的 jwt_token 转发到这里，换自有会话 cookie"——就是为 SPA 设计的 |
| ~~临时用户白名单~~（原 `_shared.ts` 的 `TEMPORARY_ALLOWED_PRODUCER_USER_IDS`） | **已删除（2026-07-08）**——已有用户权限体系（后端 RBAC + `is_active`），临时措施不再保留 | 准入控制以后端 fastapi-users 的 `is_active` 与角色权限为准 |

补充发现：后端 WS 实际只认 cookie、不解析 `bearer.<token>` 子协议（`ws_api.py` 全文无 bearer 处理）。现有"ws-ticket → bearer 子协议 → 直连后端 :7788"的链路对后端鉴权大概率本来就未生效，迁移时应验证并顺手修正。

---

## 3. 分阶段实施计划

### Phase 0：后端准备（iclip_agent，约 0.5 天）

**必须先于前端切换上线。**

> 原第 1 项"白名单移到后端"已取消：临时白名单已于 2026-07-08 从 BFF 直接删除，准入控制统一走后端既有的用户权限体系（`is_active` + RBAC 角色权限），不再有前端侧准入概念。

1. **`SSO_REDIRECT_URL` 改指前端路由** `https://<前端域名>/auth/sso/landing`（现指向 BFF 的 `/api/auth/sso/landing`）。每个环境都要改。
2. **确认 `cookie_secure` 配置**：dev（http）必须为 `false`（否则浏览器不存 cookie），生产（https）为 `true`。
3. **WS Origin 白名单**（`ws_api.py` 的 `_origin_allowed`）确认包含新前端 origin。
4. （可选）公开 `GET /config` 返回 `ssoLoginEnabled`（idesign 后端做法）。不加也可行：SSO 关闭时 SSO router 不挂载（`identity/api.py:66` 条件挂载），前端探测 `GET /auth/sso/authorize` 是否 404 即可决定登录页要不要渲染 SSO 按钮。

验收：各环境 SSO 回跳与 cookie 配置核对完毕。

### Phase 1：Vite 骨架（约 0.5 天）

在本仓库原地迁移（开分支），保留 git 历史。

1. 依赖变更：
   - 移除：`next`；新增：`vite@^8`、`@vitejs/plugin-react`、`@tanstack/react-router`、`@tanstack/router-plugin`、`@tailwindcss/vite`、`@tanstack/react-query`、`react-query-auth`、`zod`。
   - React 19、Tailwind v4、Zustand、assistant-ui、xyflow、tiptap 等全部不动。
2. 新增 `index.html`（`<div id="root">` + module 入口；可加 idesign 式的首屏主题内联脚本）与 `src/main.tsx`。
3. tsconfig 三件套（参照 idesign）：`tsconfig.json`（solution 风格 + 镜像 `paths`）、`tsconfig.app.json`（`moduleResolution: bundler`、`types: ["vite/client"]`、`paths: {"@/*": ["./src/*"]}`）、`tsconfig.node.json`。别名 `@/*` 保持不变 → 现有 210 个文件的 import 无感。
4. `vite.config.ts`（dev/prod 代理语义必须一致）：

   ```ts
   import path from 'node:path';
   import { tanstackRouter } from '@tanstack/router-plugin/vite';
   import react from '@vitejs/plugin-react';
   import tailwindcss from '@tailwindcss/vite';
   import { defineConfig } from 'vite';

   const backendProxyTarget = process.env.VITE_BACKEND_PROXY_TARGET ?? 'http://127.0.0.1:7788';
   const apiProxy = {
     '/api': {
       target: backendProxyTarget,
       rewrite: (p: string) => p.replace(/^\/api/, ''), // 后端挂根路径，去前缀
       ws: true, // /api/generations/ws
       changeOrigin: true,
     },
   };

   export default defineConfig({
     plugins: [
       tanstackRouter({ target: 'react', autoCodeSplitting: true }), // 必须在 react() 之前
       react(),
       tailwindcss(),
     ],
     resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
     server: { proxy: apiProxy },
     preview: { proxy: apiProxy },
   });
   ```

   保留客户端 `/api/...` 前缀的收益：`producer-project.api.ts`（约 850 行）等直通类调用**一行不改**（见 §4 映射表）。
5. 样式与资源平移（零成本项）：
   - `globals.css`（3633 行，Tailwind v4 CSS-first）从根 layout 的 import 改为 `main.tsx` import；`@xyflow/react/dist/style.css`、`katex/dist/katex.min.css` 同理；
   - `@font-face` 字体（`public/fonts/`）、`public/` 静态资源、`postcss.config.mjs` 删除（改用 `@tailwindcss/vite` 插件）。
6. 环境变量收敛：新建 `src/shared/config/env.ts`，zod 校验 `import.meta.env`（idesign 模式，新变量必须先进 schema）。变量映射见 §5。

验收：`vite dev` 起空壳页面；经 proxy 手动 `fetch('/api/users/me')` 能到达后端（401 也算通）。

### Phase 2：路由迁移（约 1 天）

TanStack Router 文件式路由，`src/routes/` 目录即路由树，plugin 自动生成 `routeTree.gen.ts`（加入 lint ignore）：

```
src/routes/
├── __root.tsx                     根布局（替代 app/layout.tsx：全局 CSS、Toaster、Outlet）
├── login.tsx                      /login（公开）
├── auth.sso.landing.tsx           /auth/sso/landing（公开，SSO 落地）
├── _authed.tsx                    鉴权布局（beforeLoad: await requireSession(location.href)）
└── _authed/
    ├── index.tsx                  /（原 (home)/page.tsx）
    ├── analytics.tsx              /analytics（beforeLoad 追加 requirePermission）
    └── projects.$projectId.tsx    /projects/:id（原 projects/[id]/page.tsx）
```

Next 特有 API 替换点（调研已定位全部使用位置，量都很小）：

| Next 能力 | 用量 | 替换 |
|---|---|---|
| `src/proxy.ts` 页面守卫（检查 cookie 是否存在） | 1 | `_authed.tsx` `beforeLoad` 里 `await requireSession()`。HttpOnly cookie 客户端读不到，守卫必须基于 `/users/me` 异步判定（idesign 的 `requireSession`/`requirePermission` 模式）；未登录 `throw redirect({ to: '/login', search: { redirect } })` |
| async server page | 3 | login 的 SSO 探测 → 客户端 query（探测 `/api/auth/sso/authorize`）；analytics 的服务端权限校验（`src/server/producer-auth-user.ts`）→ `beforeLoad` 客户端守卫；`projects/[id]` 的 `await params` → 路由 `useParams` |
| `next/link` | 5 处（HomeWorkspaceSections / ProjectHeaderLeft / login page / AnalyticsRoute / ProducerUserMenu） | `@tanstack/react-router` 的 `<Link>` |
| `useRouter`（next/navigation） | 3 处（HomeHero / LoginForm / ProducerUserMenu） | `useNavigate` |
| `next/image` | 3 处（login 背景图 / ProjectConversationPanel / MediaPreviewDialog） | 普通 `<img>`（登录背景加 `loading="eager"`） |
| Metadata API | 4 处（root layout / login / analytics / projects generateMetadata） | `document.title` 或 router head 管理 |
| `redirect()`（服务端） | analytics + 2 个 SSO route | `throw redirect()`（路由层）/ 随 BFF 删除 |

同步做目录归位：`app/(home)/_components`、`app/projects/[id]/_components`、`app/analytics/_components` 迁入对应 feature；路由文件保持"薄胶水"（idesign 约定：`useParams`/`useSearch` 只出现在 routes 文件，feature 组件经 props 收数据）。Zustand store（4 个）不动。

未使用项（确认无迁移成本）：Server Actions、ISR/revalidate、loading/error 边界、`next/font`、`next/dynamic`、并行/拦截路由。

验收：4 个页面可达；未登录访问受保护页跳 `/login?redirect=...`；登录后回跳原页。

### Phase 3：认证与数据层改写（约 1~1.5 天，迁移的实质工作量）

1. **会话层**（照抄 idesign `shared/auth/session.ts`，TanStack Query + react-query-auth，范围仅限 auth feature）：
   - 登录：`POST /api/auth/login`（OAuth2 表单 `URLSearchParams`）→ 204 + 浏览器直接获得 `iclip_session` → `GET /api/users/me` 进缓存（key `['auth','current-user']`）。
   - 登出：`POST /api/auth/logout`（现 BFF 登出只清自己的 cookie 不打后端；迁移后真正调后端注销会话）。
   - login/logout/SSO 完成后 `router.invalidate()` 让守卫重算——焊进 hook 回调，调用方不可漏。
   - 401 全局兜底：`apiFetch` 层挂 `setOnUnauthorized` 回调（router.tsx 注入，避免 shared 反向依赖）→ 清用户缓存 → 跳 `/login?redirect=...`；`/users/me` 与 login/logout/SSO callback 自身传 `skipUnauthorizedHandler` 豁免，防探测死循环。
2. **SSO 闭环改前端**（参照 idesign `sso-landing-page.tsx`）：
   - 登录页探测 SSO 可用性（`GET /api/auth/sso/authorize`，404 = 关闭）决定是否渲染按钮；
   - 点击 → 拿 `{ authorization_url }` → **跳转前把回跳目标写 `sessionStorage`**（替代 BFF 的 `producer_sso_next` 短时 cookie）→ `window.location.assign` 整页跳 SSO；
   - 回跳 `/auth/sso/landing?jwt_token=`（兼容 `?jwt=`）→ 前端调 `GET /api/auth/sso/callback?jwt=` 换会话 cookie → `GET /users/me` → `router.invalidate()` → 按 sessionStorage 回跳；失败 toast + 跳 `/login?ssoError=...`；
   - 落地组件 `useRef` 防 StrictMode 双跑。
3. **端点常量修正**（见 §4 映射表；只有 4 组特殊映射，其余零改动）：
   - `producer-auth.api.ts`：`/api/auth/me` → `/api/users/me`。后端响应同样是 `{user: {...camelCase}}` 包装（与旧 BFF 契约一致），`_shared.ts` 里的 `parseProducerBackendMeResponse`/`parseProducerAuthUser` mapper 原样移入该客户端模块，仅路径变化；
   - chat feature：`AGUI_RUN_ENDPOINT` 等常量改为 `/api${aguiTargetPath}/agui...`，target 路径读 `VITE_AGUI_TARGET_PATH`（默认 `/teams/producer`，替代服务端 `PRODUCER_AGUI_TARGET_PATH`，校验逻辑从 `backend-api.ts` 的 `getProducerAguiTargetDescriptor` 移植）；
   - `file-upload.ts`：`/api/files/presign` → `/api/presign`（**注意：后端路径就是 `/presign`，无 `files` 段**）；presign 后直传对象存储的第二段不变。
4. **WebSocket 简化**：`producer-generation-events.ts` 删除 ws-ticket 获取与 `bearer.<token>` 子协议，改同源直连：
   ```ts
   const wsUrl = new URL('/api/generations/ws', location.origin);
   wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
   new WebSocket(wsUrl, ['iclip-generation-v1']);
   ```
   cookie 握手自动携带；`VITE_PRODUCER_BACKEND_WS_URL` 之类的独立 WS origin 变量整个删除。
5. AG-UI 流式（SSE）经 vite proxy 冒烟验证（本阶段第一件事，见 §7 风险 3）。

验收：账密登录、SSO 登录、登出、会话过期 401 跳转、聊天流式、生成事件 WS 推送、文件上传全链路手工过一遍。

### Phase 4：删除 BFF 与清理（约 0.5 天）

- 删除：`src/app/api/`（24 route）、`src/server/`、`src/proxy.ts`、`next.config.ts`、`next-env.d.ts`、`postcss.config.mjs`、Next 相关依赖与 `@types` 残留。
- `src/features/auth/producer-auth.constants.ts` 里 BFF cookie 常量（`PRODUCER_ACCESS_TOKEN_COOKIE` 等）删除。
- 单测：76 个 spec 中约 10+ 个测 BFF route/proxy/server 助手（`auth-route`、`auth-proxy`、`agui-route`、`ws-ticket-route`、`*-api-route` 等）随 BFF 删除；白名单相关断言在后端补测。其余客户端 spec 平移（去 Next mock）。

### Phase 5：工程化、测试与部署（约 1~2 天，含联调）

1. **scripts**：`dev`(vite) / `build`(`tsc -b && vite build`) / `preview` / `typecheck`；`scripts/start-dev.sh`、`start-prod.sh` 改写或删除。Biome 保留（换 ESLint 非架构必需，不扩大范围）。
2. **vitest**：`vitest.config.ts` 并入 `vite.config.ts` 的 `test` 段或保留独立文件；jsdom 环境不变。
3. **Playwright**：webServer 改 vite。建议学 idesign 用"生产构建 + `vite preview`"跑 e2e（验证真实产物）；`PLAYWRIGHT_BASE_URL` 端口约定同步更新。
4. **CI**（`.github/workflows/ci.yml`）：构建步骤 `next build` → `pnpm build`；其余 lint/typecheck/unit/e2e 流程不变。
5. **生产部署**（架构变更点：`next start` Node 服务 → 纯静态 + 反代）。nginx 示例：

   ```nginx
   server {
     listen 80;
     client_max_body_size 100m;              # 上传放宽

     location /api/ {
       rewrite ^/api(/.*)$ $1 break;         # 与 vite proxy 的 rewrite 语义一致
       proxy_pass http://127.0.0.1:7788;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header Upgrade $http_upgrade;      # WS
       proxy_set_header Connection $connection_upgrade;
       proxy_buffering off;                  # AG-UI SSE 流式必需
       proxy_read_timeout 3600s;             # 长流不断连
     }

     location / {
       root /srv/producer/dist;
       try_files $uri $uri/ /index.html;     # SPA fallback
     }
   }
   ```

   轻量替代（不想引入 nginx）：FastAPI 直接 mount `dist/` 静态目录 + SPA fallback，天然同源；但 `/api` 前缀需在挂载时处理（后端加 `/api` root prefix 或前端去前缀）。

---

## 4. BFF route 完整映射表（24 个）

映射依据：各 `route.ts` 对 `buildBackendApiUrl` / `buildAguiBackendApiUrl` 的实际调用（已逐一核对源码）。

### 4a. 认证类（6 个 route + `_shared.ts`）——逻辑重写或删除

| BFF route | 去向 |
|---|---|
| `POST /api/auth/login` | 客户端直调后端 `/auth/login`（表单，204 + Set-Cookie），随后 `GET /users/me`。cookie 换发逻辑删除（白名单已于 2026-07-08 先行删除） |
| `POST /api/auth/logout` | 客户端直调后端 `/auth/logout`（真正注销会话） |
| `GET /api/auth/me` | 客户端直调后端 `/users/me`（**路径变了**；响应同样是 `{user}` 包装，mapper 原样移入客户端） |
| `GET /api/auth/ws-ticket` | **删除**。WS 同源 cookie 鉴权 |
| `GET /api/auth/sso/authorize` | 客户端直调后端 `/auth/sso/authorize` 拿 `{authorization_url}`，回跳目标改存 sessionStorage |
| `GET /api/auth/sso/landing` | **改为前端路由** `/auth/sso/landing`，客户端调后端 `/auth/sso/callback?jwt=` |
| `_shared.ts` | `parseProducerBackendMeResponse` 等 mapper → 客户端 auth api 模块；cookie 工厂函数删除（白名单已先行删除） |

### 4b. 直通代理类（14 个）——**客户端零改动**（`/api` 去前缀后路径一致）

| BFF route | 后端路径 |
|---|---|
| `GET /api/analytics/generation-stats` | `/analytics/generation-stats` |
| `POST /api/video-generations` | `/video-generations` |
| `GET/POST /api/projects` | `/projects` |
| `GET/PATCH /api/projects/[id]` | `/projects/{id}` |
| `GET/POST /api/projects/[id]/sessions` | `/projects/{id}/sessions` |
| `GET /api/projects/[id]/assets` | `/projects/{id}/assets` |
| `GET /api/projects/[id]/generations` | `/projects/{id}/generations` |
| `DELETE /api/sessions/[id]` | `/sessions/{id}` |
| `POST /api/sessions/[id]/rename` | `/sessions/{id}/rename` |
| `GET /api/sessions/[id]/assets` | `/sessions/{id}/assets` |
| `GET /api/sessions/[id]/generations` | `/sessions/{id}/generations` |
| `GET /api/sessions/[id]/artifacts` | `/sessions/{id}/artifacts` |
| `PUT /api/sessions/[id]/artifacts/[artifactId]` | `/sessions/{id}/artifacts/{artifactId}` |

### 4c. 特殊映射类（4 个）——客户端端点常量需更新

| BFF route | 后端路径 | 客户端改动 |
|---|---|---|
| `POST /api/agui` | `{aguiTarget}/agui`（默认 `/teams/producer/agui`） | `AGUI_RUN_ENDPOINT` → `/api/teams/producer/agui`（target 读 `VITE_AGUI_TARGET_PATH`） |
| `POST /api/agui/restore` | `{aguiTarget}/agui/restore` | 同上 |
| `POST /api/agui/state` | `{aguiTarget}/agui/state` | 同上 |
| `GET /api/agentos/runs` | `{aguiTarget}/runs?session_id=` | `AGENTOS_RUNS_ENDPOINT` → `/api/teams/producer/runs` |
| `POST /api/files/presign` | **`/presign`**（无 `files` 段！） | `file-upload.ts` → `/api/presign` |

另：WS 从 `ws://<PRODUCER_BACKEND_WS_URL>/generations/ws`（+ 无效的 bearer 子协议）改为同源 `/api/generations/ws`。

---

## 5. 环境变量映射

| 现变量 | 去向 |
|---|---|
| `PRODUCER_BACKEND_URL`（服务端） | 删除。dev 由 `VITE_BACKEND_PROXY_TARGET`（vite proxy target，默认 `http://127.0.0.1:7788`）承担；prod 由反代配置承担 |
| `PRODUCER_AGUI_TARGET_PATH`（服务端） | → `VITE_AGUI_TARGET_PATH`（客户端，默认 `/teams/producer`，进 `env.ts` zod schema） |
| `NEXT_PUBLIC_PRODUCER_BACKEND_WS_URL` | **删除**（WS 同源相对路径） |
| `NEXT_ALLOWED_DEV_ORIGINS` | 删除（如需要用 vite `server.allowedHosts`） |
| `HOST` / `PORT`（scripts，:3013） | vite `server.port` 约定（建议保留 3013 减少环境联动） |
| 后端侧 `SSO_REDIRECT_URL` | 改指前端 `/auth/sso/landing`（Phase 0） |

所有客户端变量只从 `src/shared/config/env.ts` 读（zod 校验，新变量先进 `EnvSchema`）。

---

## 6. 发布顺序

1. 后端配置核对：`cookie_secure`、WS Origin 白名单（白名单准入已由既有用户权限体系承担，无后端代码变更）。
2. 前端切换：部署 Vite dist + 反代；同步更新 `SSO_REDIRECT_URL`。
3. 切换后浏览器里旧的 `producer_access_token` cookie 自然失效（无人读取），用户重新登录一次即可。
4. 回滚路径：反代切回 Next 服务即可（Phase 0 的后端改动对旧 BFF 无破坏）。

---

## 7. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| 1 | 白名单删除后，SSO `associate_by_email` 自动建号的新用户默认可登录（首登角色为 viewer） | 有意为之的行为变更（2026-07-08 决策）：准入统一依赖后端 `is_active` 与 RBAC 角色权限管理 |
| 2 | 会话时长语义变化：`producer_access_token` 固定 7 天 → 后端 `lifetime_seconds` 说了算 | 确认后端配置符合预期时长 |
| 3 | AG-UI SSE 经代理断流/缓冲 | Phase 3 第一件事冒烟聊天流；生产 nginx `proxy_buffering off` + 长 `proxy_read_timeout` |
| 4 | `cookie_secure=true` 时 http dev 环境浏览器不存 cookie（登录"成功"但无会话） | Phase 0 逐环境核对配置 |
| 5 | `SSO_REDIRECT_URL` 是环境级配置，易漏改 | 发布 checklist 逐环境核对 |
| 6 | dev(vite rewrite) 与 prod(nginx rewrite) 语义不一致导致"本地好的线上 404" | 两处 rewrite 规则在本文档 §3 固化为同一语义；e2e 跑生产构建 |
| 7 | `/api/presign` 特殊映射易被想当然写成 `/api/files/presign` | §4c 已标注；迁移时对照 route.ts 逐个核对 |
| 8 | 现网 WS 鉴权链路本就可疑（bearer 子协议后端不认） | 迁移时验证 WS 推送端到端可用，视为顺手修复 |

---

## 8. 工作量估计

| 阶段 | 内容 | 估时 |
|---|---|---|
| Phase 0 | 后端 SSO/cookie 配置核对 | 0.5 天 |
| Phase 1 | Vite 骨架 + proxy + 样式平移 | 0.5 天 |
| Phase 2 | 路由迁移（4 页面 + 守卫） | 1 天 |
| Phase 3 | 认证/SSO/WS/端点改写 | 1~1.5 天 |
| Phase 4 | 删 BFF + 测试清理 | 0.5 天 |
| Phase 5 | 工程化 + e2e + 部署联调 | 1~2 天 |
| **合计** | | **约 4~6 天** |

规模判断依据：约 4 万行前端代码中，画布/聊天/富文本等 87 个客户端组件与 Next 几乎零耦合（全部相对路径 fetch + Zustand）；真正重写集中在 auth 一个 feature；BFF 24 个 route 与 `src/server/` 整体删除。这次迁移是"删多写少"。

---

## 9. 可选后续增强（不阻塞迁移）

做完后与 idesign_forent 完全对齐，建议迁移稳定后按需推进：

1. **TanStack Query 推广到全部 feature API**（迁移期仅 auth 用；`producer-project.api.ts` 等保持原生 fetch）。
2. **`apiFetch + zod` 统一边界校验**（替代现有手写 `readXxxJSON` + mapper）。
3. **MSW mock 层**（dev/单测/e2e 共用 handlers，镜像后端契约）。
4. **ESLint `eslint-plugin-boundaries` 依赖方向硬约束**（`main → app → routes → features → shared` 单向）——需先决策是否从 Biome 迁回 ESLint。
5. 消费后端 RBAC `permissions` 字段做细粒度 UI 权限（analytics 守卫是第一个消费点）。
