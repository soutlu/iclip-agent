# Vite 纯 SPA + 同源代理直连后端，不再保留 BFF

日期：2026-07-08 ｜ 状态：已实施（master @ 446763e 起）｜ 来源计划：`../archive/vite-migration-plan.md`

Producer 从 Next.js 16（App Router + 24 个 BFF API route）迁移为 Vite 8 纯 SPA：
TanStack Router 文件式路由 + TanStack Query 数据层，浏览器经同源 `/api` 前缀直连
`iclip_agent` 后端（dev 用 vite proxy，prod 用反代，rewrite 语义相同：去掉 `/api` 前缀）。

## 为什么

- Next.js 在本项目里只被当作路由壳（4 个页面）+ BFF 代理层；87 个 `'use client'` 组件承载全部业务 UI，SSR 能力完全未使用。
- BFF 的核心职能是认证转换：把后端 fastapi-users 签发的 `iclip_session` cookie（JWT）换发成前端自己的 HttpOnly cookie `producer_access_token`，再在代理时还原为 Bearer。同源部署下这层转换没有存在价值，反而制造了双 cookie、双错误路径和 24 个需要维护的代理 route。
- 对齐参考架构 `idesign_forent`（同 workspace 姐妹项目验证过的形态）：无 BFF 纯 SPA、HttpOnly cookie 直达浏览器、`GET /users/me` 进 TanStack Query 缓存作为登录态唯一事实源。

## 硬约束（违反即回归）

- 前端 JavaScript 不持有、不存储、不转发任何 token；登录态只存在于后端种的 HttpOnly `iclip_session` cookie 里。
- 浏览器只调用同源 `/api/*`；vite proxy / 生产反代负责 `^/api` → 后端根路径 rewrite（见 `vite.config.ts`）。代理目标经 shell 环境变量 `VITE_BACKEND_PROXY_TARGET` 配置（`process.env` 读取，不走 `.env` 文件）。
- 不恢复任何形态的 BFF、cookie 换发或 `producer_access_token`。
- 登录态事实源是 `GET /api/users/me`（返回 `{user: {...camelCase}}` 包装），经 react-query-auth 进 TanStack Query 缓存（`src/shared/auth/session.ts`）。
- `ICLIP_FRONTEND_PUBLIC_ORIGIN` 只用于由启动器派生 SSO 回跳地址。Vite 必须让 `/api` 保持当前页面同源，不得通过 3xx 把 API 请求重定向到另一个 Host；同一登录会话不得在 `localhost`、`127.0.0.1` 或局域网地址之间混用 host-only cookie。
- 真实后端开发使用纯 backend profile，不注册 Service Worker；浏览器 MSW 只允许出现在显式 `prototype` / `mock` profile，不能把真实认证与局部 mock 混进默认全栈运行时。

## 后果

- 路由守卫从 Next proxy/middleware 改为 TanStack Router `beforeLoad`（async，`src/shared/auth/guards.ts`）。
- AG-UI、项目、上传等所有接口调用从 BFF 路径改为同源直连（当前端点清单见 `../backend_api.md`）。
- 环境变量从 `NEXT_PUBLIC_*` 改为 `VITE_*`，只经 `src/shared/config/env.ts` 的 zod schema 读取（如 `VITE_AGUI_TARGET_PATH`，默认 `/teams/producer`）。
- 后端 SSO 回跳地址（`ICLIP_SSO_REDIRECT_URL`）指向前端路由 `/auth/sso/landing`，由页面用 jwt 调 `GET /api/auth/sso/callback` 换会话 cookie。
- 普通接口 401 只触发一次不使用缓存的 `/users/me` 复核；确认未登录后由路由守卫跳转，不能把一次 endpoint 401 直接固化为本地未登录态。
